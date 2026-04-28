import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';
import stealth from './stealth';
import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { spawn, execSync } from 'child_process';
import * as os from 'os';
import type { ChildProcess } from 'child_process';
import type { ToolModule, McpToolDefinition, McpToolResult, ToolVisibility } from '../../types';

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const VNC_DISPLAY_BASE = 100;
const VNC_PORT_BASE = 5901;
const TOKEN_FILE = '/tmp/vnc-tokens.cfg';

function getAgentsBaseDir(): string {
  return process.env.GATEWAY_AGENTS_BASE_DIR ?? path.join(os.homedir(), '.claude-gateway', 'agents');
}

function agentBrowserDir(agentId: string): string {
  return path.join(getAgentsBaseDir(), agentId, 'browser-profile');
}

function sessionBrowserDir(agentId: string, sessionId: string): string {
  return path.join(getAgentsBaseDir(), agentId, 'browser-sessions', sessionId);
}

// Module-level state — persists across BrowserModule instances in the same process
let _websockifyTokenMode = false;

function isPortInUse(port: number): boolean {
  try {
    const hex = port.toString(16).toUpperCase().padStart(4, '0');
    const content = readFileSync('/proc/net/tcp', 'utf-8');
    return content.split('\n').some((line) => {
      const parts = line.trim().split(/\s+/);
      return parts.length >= 2 && parts[1].endsWith(`:${hex}`);
    });
  } catch {
    return false;
  }
}

function findNextAvailableDisplay(): number {
  let n = VNC_DISPLAY_BASE;
  while (existsSync(`/tmp/.X${n}-lock`) || isPortInUse(VNC_PORT_BASE + (n - VNC_DISPLAY_BASE))) n++;
  return n;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface VncStateFile {
  display: number;
  vncPort: number;
  token: string;
  pid_xvfb: number;
  pid_x11vnc: number;
}

interface VncSession {
  display: number;
  vncPort: number;
  token: string;
  xvfbProc: ChildProcess | null;
  x11vncProc: ChildProcess | null;
  pid_xvfb: number;
  pid_x11vnc: number;
}

export class BrowserModule implements ToolModule {
  id = 'browser';
  toolVisibility: ToolVisibility = 'all-configured';

  readonly agentId: string;
  private contexts = new Map<string, BrowserContext>();
  private lastActivity = new Map<string, number>();
  private vncSessions = new Map<string, VncSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.agentId = process.env.GATEWAY_AGENT_ID ?? 'default';
    if (this.isEnabled()) {
      this.startCleanupTimer();
    }
  }

  isEnabled(): boolean {
    return !!process.env.DISPLAY;
  }

  private resolveSessionId(args: Record<string, unknown>): string {
    return (args.session_id as string | undefined) ?? process.env.GATEWAY_SESSION_ID ?? 'default';
  }

  getTools(): McpToolDefinition[] {
    return [
      {
        name: 'browser_navigate',
        description:
          'Navigate to a URL in the browser session. Returns page title, current URL, and VNC viewer URL.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Unique identifier for the browser session' },
            url: { type: 'string', description: 'URL to navigate to' },
          },
          required: ['url'],
          additionalProperties: false,
        },
      },
      {
        name: 'browser_screenshot',
        description: 'Take a screenshot of the current page. Returns base64-encoded PNG.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Unique identifier for the browser session' },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'browser_click',
        description: 'Click an element matching the CSS selector.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Unique identifier for the browser session' },
            selector: { type: 'string', description: 'CSS selector of the element to click' },
          },
          required: ['selector'],
          additionalProperties: false,
        },
      },
      {
        name: 'browser_fill',
        description: 'Fill an input field matching the CSS selector with a value.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Unique identifier for the browser session' },
            selector: { type: 'string', description: 'CSS selector of the input element' },
            value: { type: 'string', description: 'Value to fill into the input' },
          },
          required: ['selector', 'value'],
          additionalProperties: false,
        },
      },
      {
        name: 'browser_get_text',
        description: 'Get text content of the page or a specific element.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Unique identifier for the browser session' },
            selector: {
              type: 'string',
              description: 'Optional CSS selector. If omitted, returns full body text.',
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'browser_evaluate',
        description: 'Evaluate a JavaScript expression in the page context. Returns JSON-serialized result.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Unique identifier for the browser session' },
            expression: { type: 'string', description: 'JavaScript expression to evaluate' },
          },
          required: ['expression'],
          additionalProperties: false,
        },
      },
      {
        name: 'browser_close_session',
        description: 'Close the browser context (frees memory) but keep session data on disk for resume.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Unique identifier for the browser session' },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'browser_delete_session',
        description: 'Permanently close and delete a browser session including all disk data.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Unique identifier for the browser session' },
          },
          required: [],
          additionalProperties: false,
        },
      },
    ];
  }

  async handleTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    try {
      const sessionId = this.resolveSessionId(args);
      let result: unknown;

      switch (name) {
        case 'browser_navigate':
          result = await this.navigate(sessionId, args.url as string);
          break;
        case 'browser_screenshot':
          result = await this.screenshot(sessionId);
          break;
        case 'browser_click':
          result = await this.click(sessionId, args.selector as string);
          break;
        case 'browser_fill':
          result = await this.fill(sessionId, args.selector as string, args.value as string);
          break;
        case 'browser_get_text':
          result = await this.getText(sessionId, args.selector as string | undefined);
          break;
        case 'browser_evaluate':
          result = await this.evaluate(sessionId, args.expression as string);
          break;
        case 'browser_close_session':
          result = await this.closeSession(sessionId);
          break;
        case 'browser_delete_session':
          result = await this.deleteSession(sessionId);
          break;
        default:
          return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      }

      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
    }
  }

  async getContext(sessionId: string): Promise<BrowserContext> {
    if (this.contexts.has(sessionId)) {
      this.lastActivity.set(sessionId, Date.now());
      return this.contexts.get(sessionId)!;
    }

    const vnc = await this.spawnVnc(sessionId);

    const userDataDir = path.join(sessionBrowserDir(this.agentId, sessionId), 'userDataDir');
    await fs.mkdir(userDataDir, { recursive: true });

    const ctx = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      executablePath: '/usr/bin/google-chrome-stable',
      env: { ...process.env, DISPLAY: `:${vnc.display}` },
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--no-sandbox',
        '--test-type',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
      ],
    });

    const webdriverPatch = `Object.defineProperty(navigator, 'webdriver', { get: () => false });`;

    // patch navigator.webdriver + CDP artifacts on every new page
    ctx.on('page', async (page) => {
      await page.addInitScript(webdriverPatch);
      await stealth(page);
    });

    // patch existing pages (first page created with the context)
    for (const page of ctx.pages()) {
      await page.addInitScript(webdriverPatch);
      await stealth(page);
    }

    // Import shared cookies (login state from other sessions)
    await this.importSharedCookies(ctx);

    // Restore last-known tabs from previous session
    await this.restoreTabState(sessionId, ctx);

    this.contexts.set(sessionId, ctx);
    this.lastActivity.set(sessionId, Date.now());
    return ctx;
  }

  private async getPage(sessionId: string): Promise<Page> {
    const ctx = await this.getContext(sessionId);
    const pages = ctx.pages();
    return pages.length > 0 ? pages[0] : ctx.newPage();
  }

  async navigate(
    sessionId: string,
    url: string,
  ): Promise<{ title: string; current_url: string; vnc_url: string }> {
    const page = await this.getPage(sessionId);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const ctx = this.contexts.get(sessionId)!;
    await this.syncStorageState(ctx).catch(() => {});
    const vnc = this.vncSessions.get(sessionId);
    const token = encodeURIComponent(vnc?.token ?? sessionId);
    const vncUrl = `/browser/vnc.html?autoconnect=true&path=browser%2Fwebsockify%3Ftoken%3D${token}`;
    return { title: await page.title(), current_url: page.url(), vnc_url: vncUrl };
  }

  async screenshot(sessionId: string): Promise<{ image_base64: string }> {
    const page = await this.getPage(sessionId);
    await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
    // Trigger at least one compositor frame before capturing
    await page.evaluate('new Promise(r => requestAnimationFrame(r))').catch(() => {});
    const buffer = await page.screenshot({ type: 'png' });
    return { image_base64: buffer.toString('base64') };
  }

  async click(sessionId: string, selector: string): Promise<{ success: boolean }> {
    const page = await this.getPage(sessionId);
    await page.click(selector, { timeout: 5000 });
    const ctx = this.contexts.get(sessionId)!;
    await this.syncStorageState(ctx).catch(() => {});
    return { success: true };
  }

  async fill(sessionId: string, selector: string, value: string): Promise<{ success: boolean }> {
    const page = await this.getPage(sessionId);
    await page.fill(selector, value);
    const ctx = this.contexts.get(sessionId)!;
    await this.syncStorageState(ctx).catch(() => {});
    return { success: true };
  }

  async getText(sessionId: string, selector?: string): Promise<{ text: string | null }> {
    const page = await this.getPage(sessionId);
    if (selector) {
      return { text: await page.textContent(selector) };
    }
    return { text: (await page.evaluate('document.body.innerText')) as string };
  }

  async evaluate(sessionId: string, expression: string): Promise<{ result: string }> {
    const page = await this.getPage(sessionId);
    const value = await page.evaluate(expression);
    return { result: JSON.stringify(value) };
  }

  async closeSession(sessionId: string): Promise<{ success: boolean }> {
    const ctx = this.contexts.get(sessionId);
    if (ctx) {
      await this.saveTabState(sessionId, ctx);
      await this.syncStorageState(ctx).catch(() => {});
      await ctx.close();
      this.contexts.delete(sessionId);
      this.lastActivity.delete(sessionId);
    }
    await this.stopVnc(sessionId);
    return { success: true };
  }

  async deleteSession(sessionId: string): Promise<{ success: boolean }> {
    await this.closeSession(sessionId);
    // Remove session-level dir (userDataDir, tabs, vnc-state) but NOT the shared agent profile
    const sessionDir = sessionBrowserDir(this.agentId, sessionId);
    await fs.rm(sessionDir, { recursive: true, force: true });
    return { success: true };
  }

  async runCleanup(): Promise<void> {
    const now = Date.now();
    for (const [sessionId, lastTs] of this.lastActivity) {
      if (now - lastTs > SESSION_TIMEOUT_MS) {
        await this.closeSession(sessionId);
        console.log(`[browser] idle close: ${sessionId}`);
      }
    }
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.runCleanup().catch((err) => {
        console.error('[browser] cleanup error:', (err as Error).message);
      });
    }, CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  // ── Storage state helpers ──────────────────────────────────────────────────

  private async importSharedCookies(ctx: BrowserContext): Promise<void> {
    const sharedStateFile = path.join(agentBrowserDir(this.agentId), 'shared-state.json');
    if (!existsSync(sharedStateFile)) return;
    try {
      const state = JSON.parse(readFileSync(sharedStateFile, 'utf-8')) as { cookies?: unknown[] };
      if (state.cookies?.length) {
        await ctx.addCookies(state.cookies as Parameters<typeof ctx.addCookies>[0]);
      }
    } catch {
      // non-fatal: corrupted shared state
    }
  }

  async syncStorageState(ctx: BrowserContext): Promise<void> {
    const dir = agentBrowserDir(this.agentId);
    await fs.mkdir(dir, { recursive: true });
    const sharedFile = path.join(dir, 'shared-state.json');
    const tmp = sharedFile + '.tmp';
    await ctx.storageState({ path: tmp });
    await fs.rename(tmp, sharedFile); // atomic rename — safe against concurrent writes
  }

  private async saveTabState(sessionId: string, ctx: BrowserContext): Promise<void> {
    const urls = ctx
      .pages()
      .map((p) => p.url())
      .filter((u) => u && u !== 'about:blank');
    if (urls.length === 0) return;
    const dir = sessionBrowserDir(this.agentId, sessionId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'tabs.json'), JSON.stringify({ urls }));
  }

  private async restoreTabState(sessionId: string, ctx: BrowserContext): Promise<void> {
    const tabsFile = path.join(sessionBrowserDir(this.agentId, sessionId), 'tabs.json');
    if (!existsSync(tabsFile)) return;
    try {
      const { urls } = JSON.parse(readFileSync(tabsFile, 'utf-8')) as { urls: string[] };
      for (const url of urls.slice(0, 5)) {
        const page = await ctx.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
      }
    } catch {
      // non-fatal: bad JSON or network error
    }
  }

  // ── VNC session management ─────────────────────────────────────────────────

  private async ensureWebsockifyTokenMode(): Promise<void> {
    if (_websockifyTokenMode) return;
    _websockifyTokenMode = true;

    // Check if websockify is already running in token mode (cross-process safe)
    try {
      const out = execSync('pgrep -fa websockify 2>/dev/null || true').toString();
      const tokenModeProcs = out.split('\n').filter((l) => l.includes('TokenFile') && l.trim());
      if (tokenModeProcs.length >= 1) {
        // Kill duplicate instances if more than one, keep the first
        if (tokenModeProcs.length > 1) {
          tokenModeProcs.slice(1).forEach((line) => {
            const pid = line.trim().split(/\s+/)[0];
            try {
              execSync(`kill ${pid} 2>/dev/null || true`);
            } catch {
              // ignore
            }
          });
        }
        // Token file is intact — do not clear it
        return;
      }
      // 0 instances → fall through to start one
    } catch {
      // ignore
    }

    // Start websockify without clearing the token file — existing tokens from other sessions are preserved
    spawn(
      'websockify',
      [
        '--web=/usr/share/novnc',
        `--token-plugin=TokenFile`,
        `--token-source=${TOKEN_FILE}`,
        '--log-file=/tmp/websockify-token.log',
        '0.0.0.0:6080',
      ],
      { detached: true, stdio: 'ignore' },
    ).unref();

    await new Promise((r) => setTimeout(r, 500));
  }

  async spawnVnc(sessionId: string): Promise<VncSession> {
    if (this.vncSessions.has(sessionId)) {
      return this.vncSessions.get(sessionId)!;
    }

    await this.ensureWebsockifyTokenMode();

    // Try to reconnect to a previously-spawned VNC session (survives MCP subprocess restart)
    const stateFile = path.join(sessionBrowserDir(this.agentId, sessionId), 'vnc-state.json');
    if (existsSync(stateFile)) {
      try {
        const saved = JSON.parse(readFileSync(stateFile, 'utf-8')) as VncStateFile;
        const xvfbAlive = processAlive(saved.pid_xvfb) && existsSync(`/tmp/.X${saved.display}-lock`);
        const vncAlive = processAlive(saved.pid_x11vnc);
        if (xvfbAlive && vncAlive) {
          // Re-append token in case websockify restarted (e.g. container reboot)
          await fs.appendFile(TOKEN_FILE, `${saved.token}: localhost:${saved.vncPort}\n`).catch(() => {});
          const vnc: VncSession = {
            ...saved,
            xvfbProc: null,
            x11vncProc: null,
          };
          this.vncSessions.set(sessionId, vnc);
          return vnc;
        }
        // Stale state — clean up and respawn below
        await fs.unlink(stateFile).catch(() => {});
      } catch {
        // Corrupted state file — ignore and respawn
        await fs.unlink(stateFile).catch(() => {});
      }
    }

    const display = findNextAvailableDisplay();
    const vncPort = VNC_PORT_BASE + (display - VNC_DISPLAY_BASE);

    const xvfbProc = spawn(
      'Xvfb',
      [`:${display}`, '-screen', '0', '1280x800x24', '-ac', '+extension', 'GLX', '+render', '-noreset'],
      { stdio: 'ignore' },
    );

    // Wait until Xvfb creates its lock file (actual readiness signal)
    const lockFile = `/tmp/.X${display}-lock`;
    for (let i = 0; i < 30; i++) {
      if (existsSync(lockFile)) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const x11vncProc = spawn(
      'x11vnc',
      [
        '-display',
        `:${display}`,
        '-nopw',
        '-listen',
        '127.0.0.1',
        '-rfbport',
        String(vncPort),
        '-forever',
        '-shared',
        '-logfile',
        `/tmp/x11vnc-${display}.log`,
      ],
      { stdio: 'ignore' },
    );

    const token = crypto.randomUUID();
    await fs.appendFile(TOKEN_FILE, `${token}: localhost:${vncPort}\n`).catch(() => {});

    const vnc: VncSession = {
      display,
      vncPort,
      token,
      xvfbProc,
      x11vncProc,
      pid_xvfb: xvfbProc.pid!,
      pid_x11vnc: x11vncProc.pid!,
    };
    this.vncSessions.set(sessionId, vnc);

    // Persist state for resume after subprocess restart
    await this.saveVncState(sessionId, vnc);

    return vnc;
  }

  private async saveVncState(sessionId: string, vnc: VncSession): Promise<void> {
    const dir = sessionBrowserDir(this.agentId, sessionId);
    await fs.mkdir(dir, { recursive: true });
    const state: VncStateFile = {
      display: vnc.display,
      vncPort: vnc.vncPort,
      token: vnc.token,
      pid_xvfb: vnc.pid_xvfb,
      pid_x11vnc: vnc.pid_x11vnc,
    };
    await fs.writeFile(path.join(dir, 'vnc-state.json'), JSON.stringify(state));
  }

  async stopVnc(sessionId: string): Promise<void> {
    const vnc = this.vncSessions.get(sessionId);
    if (!vnc) return;

    if (vnc.x11vncProc) {
      try {
        vnc.x11vncProc.kill('SIGTERM');
      } catch {}
    } else if (vnc.pid_x11vnc) {
      try {
        process.kill(vnc.pid_x11vnc, 'SIGTERM');
      } catch {}
    }

    if (vnc.xvfbProc) {
      try {
        vnc.xvfbProc.kill('SIGTERM');
      } catch {}
    } else if (vnc.pid_xvfb) {
      try {
        process.kill(vnc.pid_xvfb, 'SIGTERM');
      } catch {}
    }

    try {
      const content = await fs.readFile(TOKEN_FILE, 'utf-8');
      const lines = content.split('\n').filter((l) => !l.startsWith(`${vnc.token}:`));
      await fs.writeFile(TOKEN_FILE, lines.join('\n'));
    } catch {}

    // Remove VNC state file
    const stateFile = path.join(sessionBrowserDir(this.agentId, sessionId), 'vnc-state.json');
    await fs.unlink(stateFile).catch(() => {});

    this.vncSessions.delete(sessionId);
  }
}
