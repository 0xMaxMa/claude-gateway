import * as path from 'path';
import * as fs from 'fs/promises';
import { BrowserModule } from '../../mcp/tools/browser/module';

const TOKEN_FILE = '/tmp/vnc-tokens.cfg';

const SESSION_BASE_DIR = '/tmp/browser-sessions';

// U1, U2: isEnabled checks (no browser needed)
describe('BrowserModule - isEnabled', () => {
  let originalDisplay: string | undefined;

  beforeEach(() => {
    originalDisplay = process.env.DISPLAY;
  });

  afterEach(() => {
    if (originalDisplay === undefined) {
      delete process.env.DISPLAY;
    } else {
      process.env.DISPLAY = originalDisplay;
    }
  });

  it('U1: returns false when DISPLAY is not set', () => {
    delete process.env.DISPLAY;
    expect(new BrowserModule().isEnabled()).toBe(false);
  });

  it('U2: returns true when DISPLAY is set', () => {
    process.env.DISPLAY = ':99';
    expect(new BrowserModule().isEnabled()).toBe(true);
  });
});

// U6: getTools returns 8 tool definitions (no browser needed)
describe('BrowserModule - getTools', () => {
  it('U6: returns 8 browser tool definitions', () => {
    const mod = new BrowserModule();
    const tools = mod.getTools();
    expect(tools).toHaveLength(8);
    const names = tools.map((t) => t.name);
    expect(names).toContain('browser_navigate');
    expect(names).toContain('browser_screenshot');
    expect(names).toContain('browser_click');
    expect(names).toContain('browser_fill');
    expect(names).toContain('browser_get_text');
    expect(names).toContain('browser_evaluate');
    expect(names).toContain('browser_close_session');
    expect(names).toContain('browser_delete_session');
  });
});

// VNC unit tests (require DISPLAY + Xvfb + x11vnc)
describe('BrowserModule - VNC session management', () => {
  let mod: BrowserModule;

  beforeEach(() => {
    mod = new BrowserModule();
  });

  afterEach(async () => {
    await mod.deleteSession('vnc-sess-1').catch(() => {});
    await mod.deleteSession('vnc-sess-2').catch(() => {});
  }, 30000);

  it('spawnVnc returns VNC session with display >= 100 and port >= 5901', async () => {
    const vnc = await (mod as any).spawnVnc('vnc-sess-1');
    expect(vnc.display).toBeGreaterThanOrEqual(100);
    expect(vnc.vncPort).toBeGreaterThanOrEqual(5901);
    expect(vnc.xvfbProc).toBeDefined();
    expect(vnc.x11vncProc).toBeDefined();
  }, 10000);

  it('spawnVnc for same session returns cached VNC session', async () => {
    const vnc1 = await (mod as any).spawnVnc('vnc-sess-1');
    const vnc2 = await (mod as any).spawnVnc('vnc-sess-1');
    expect(vnc1).toBe(vnc2);
  }, 10000);

  it('two sessions get different display numbers and ports', async () => {
    const vnc1 = await (mod as any).spawnVnc('vnc-sess-1');
    const vnc2 = await (mod as any).spawnVnc('vnc-sess-2');
    expect(vnc1.display).not.toBe(vnc2.display);
    expect(vnc1.vncPort).not.toBe(vnc2.vncPort);
  }, 10000);

  it('stopVnc removes VNC session from vncSessions map', async () => {
    await (mod as any).spawnVnc('vnc-sess-1');
    expect((mod as any).vncSessions.has('vnc-sess-1')).toBe(true);
    await (mod as any).stopVnc('vnc-sess-1');
    expect((mod as any).vncSessions.has('vnc-sess-1')).toBe(false);
  }, 10000);

  it('token file contains session entry after spawnVnc', async () => {
    await (mod as any).spawnVnc('vnc-sess-1');
    const token = (mod as any).vncSessions.get('vnc-sess-1')!.token as string;
    const content = await fs.readFile(TOKEN_FILE, 'utf-8');
    expect(content).toContain(`${token}:`);
  }, 10000);

  it('token file entry removed after stopVnc', async () => {
    await (mod as any).spawnVnc('vnc-sess-1');
    const token = (mod as any).vncSessions.get('vnc-sess-1')!.token as string;
    await (mod as any).stopVnc('vnc-sess-1');
    const content = await fs.readFile(TOKEN_FILE, 'utf-8').catch(() => '');
    expect(content).not.toContain(`${token}:`);
  }, 10000);

  it('getContext creates VNC session with display >= 100', async () => {
    await mod.getContext('vnc-sess-1');
    const vnc = (mod as any).vncSessions.get('vnc-sess-1');
    expect(vnc).toBeDefined();
    expect(vnc.display).toBeGreaterThanOrEqual(100);
  }, 30000);
});

// U3, U4, U5: session isolation (requires DISPLAY + Chromium)
describe('BrowserModule - session isolation', () => {
  let mod: BrowserModule;

  beforeEach(() => {
    mod = new BrowserModule();
  });

  afterEach(async () => {
    await mod.deleteSession('sess-1').catch(() => {});
    await mod.deleteSession('sess-2').catch(() => {});
    await mod.deleteSession('sess-resume').catch(() => {});
  }, 30000);

  it('U5: creates separate user data dirs per session', async () => {
    await mod.getContext('sess-1');
    await mod.getContext('sess-2');
    const stat1 = await fs.stat(path.join(SESSION_BASE_DIR, 'sess-1'));
    const stat2 = await fs.stat(path.join(SESSION_BASE_DIR, 'sess-2'));
    expect(stat1.isDirectory()).toBe(true);
    expect(stat2.isDirectory()).toBe(true);
  }, 30000);

  it('U3: returns same context object for same session_id (in-memory)', async () => {
    const ctx1 = await mod.getContext('sess-1');
    const ctx2 = await mod.getContext('sess-1');
    expect(ctx1).toBe(ctx2);
  }, 30000);

  it('U4: returns different context objects for different session_ids', async () => {
    const ctx1 = await mod.getContext('sess-1');
    const ctx2 = await mod.getContext('sess-2');
    expect(ctx1).not.toBe(ctx2);
  }, 30000);

  it('resumes session after close (localStorage persists on disk)', async () => {
    const ctx1 = await mod.getContext('sess-resume');
    const page1 = ctx1.pages().length > 0 ? ctx1.pages()[0] : await ctx1.newPage();
    await page1.goto('https://example.com');
    await page1.evaluate("localStorage.setItem('persist_key', 'persist_value')");
    await mod.closeSession('sess-resume');

    const ctx2 = await mod.getContext('sess-resume');
    const page2 = ctx2.pages().length > 0 ? ctx2.pages()[0] : await ctx2.newPage();
    await page2.goto('https://example.com');
    const val = await page2.evaluate("localStorage.getItem('persist_key')");
    expect(val).toBe('persist_value');
  }, 30000);
});
