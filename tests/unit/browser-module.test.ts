import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import { BrowserModule } from '../../mcp/tools/browser/module';

const CHROME_PATH = '/usr/bin/google-chrome-stable';

// ── helpers ──────────────────────────────────────────────────────────────────

let testAgentsBaseDir: string;
let savedEnv: Record<string, string | undefined>;

function setTestEnv(agentId = 'test-agent', sessionId = 'test-session') {
  savedEnv = {
    GATEWAY_AGENTS_BASE_DIR: process.env.GATEWAY_AGENTS_BASE_DIR,
    GATEWAY_AGENT_ID: process.env.GATEWAY_AGENT_ID,
    GATEWAY_SESSION_ID: process.env.GATEWAY_SESSION_ID,
  };
  process.env.GATEWAY_AGENTS_BASE_DIR = testAgentsBaseDir;
  process.env.GATEWAY_AGENT_ID = agentId;
  process.env.GATEWAY_SESSION_ID = sessionId;
}

function restoreEnv() {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// ── U1, U2: isEnabled ────────────────────────────────────────────────────────

describe('BrowserModule - isEnabled', () => {
  let originalDisplay: string | undefined;

  beforeEach(() => {
    originalDisplay = process.env.DISPLAY;
  });

  afterEach(() => {
    if (originalDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = originalDisplay;
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

// ── U6: getTools ─────────────────────────────────────────────────────────────

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

  it('browser_navigate requires only url, session_id is optional', () => {
    const mod = new BrowserModule();
    const nav = mod.getTools().find((t) => t.name === 'browser_navigate')!;
    const required = (nav.inputSchema as any).required as string[];
    expect(required).toContain('url');
    expect(required).not.toContain('session_id');
  });

  it('browser_screenshot requires no args', () => {
    const mod = new BrowserModule();
    const ss = mod.getTools().find((t) => t.name === 'browser_screenshot')!;
    const required = ((ss.inputSchema as any).required ?? []) as string[];
    expect(required).not.toContain('session_id');
  });
});

// ── T2: session_id env fallback ───────────────────────────────────────────────

describe('BrowserModule - resolveSessionId', () => {
  beforeAll(async () => {
    testAgentsBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-test-'));
  });

  afterAll(async () => {
    await fs.rm(testAgentsBaseDir, { recursive: true, force: true });
  });

  beforeEach(() => setTestEnv());
  afterEach(restoreEnv);

  it('uses explicit session_id when provided', () => {
    const mod = new BrowserModule();
    const result = (mod as any).resolveSessionId({ session_id: 'explicit-id' });
    expect(result).toBe('explicit-id');
  });

  it('falls back to GATEWAY_SESSION_ID when session_id not provided', () => {
    process.env.GATEWAY_SESSION_ID = 'env-session-uuid';
    const mod = new BrowserModule();
    const result = (mod as any).resolveSessionId({});
    expect(result).toBe('env-session-uuid');
  });

  it('falls back to "default" when neither arg nor env is set', () => {
    delete process.env.GATEWAY_SESSION_ID;
    const mod = new BrowserModule();
    const result = (mod as any).resolveSessionId({});
    expect(result).toBe('default');
  });
});

// ── T3: persistent path layout ───────────────────────────────────────────────

describe('BrowserModule - persistent directory layout', () => {
  beforeAll(async () => {
    testAgentsBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-test-'));
  });

  afterAll(async () => {
    await fs.rm(testAgentsBaseDir, { recursive: true, force: true });
  });

  beforeEach(() => setTestEnv('agent-a', 'sess-x'));
  afterEach(restoreEnv);

  it('agentId is read from GATEWAY_AGENT_ID env', () => {
    const mod = new BrowserModule();
    expect(mod.agentId).toBe('agent-a');
  });

  it('getContext creates userDataDir under AGENTS_BASE_DIR/{agentId}/browser-sessions/{sessionId}', async () => {
    const mod = new BrowserModule();
    await mod.getContext('sess-x');
    const expected = path.join(testAgentsBaseDir, 'agent-a', 'browser-sessions', 'sess-x', 'userDataDir');
    const stat = await fs.stat(expected);
    expect(stat.isDirectory()).toBe(true);
    await mod.deleteSession('sess-x');
  }, 30000);

  it('deleteSession removes session dir but not agent-level browser-profile', async () => {
    const mod = new BrowserModule();
    await mod.getContext('sess-x');

    // Ensure agent-level dir exists
    const agentDir = path.join(testAgentsBaseDir, 'agent-a', 'browser-profile');
    await fs.mkdir(agentDir, { recursive: true });

    await mod.deleteSession('sess-x');

    // session dir gone
    const sessionDir = path.join(testAgentsBaseDir, 'agent-a', 'browser-sessions', 'sess-x');
    expect(fsSync.existsSync(sessionDir)).toBe(false);

    // agent-level dir still present
    expect(fsSync.existsSync(agentDir)).toBe(true);
  }, 30000);
});

// ── T3: storageState sync ────────────────────────────────────────────────────

describe('BrowserModule - storageState sync', () => {
  beforeAll(async () => {
    testAgentsBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-test-'));
  });

  afterAll(async () => {
    await fs.rm(testAgentsBaseDir, { recursive: true, force: true });
  });

  beforeEach(() => setTestEnv('agent-b', 'sess-sync'));
  afterEach(restoreEnv);

  it('syncStorageState creates shared-state.json under agent browser-profile dir', async () => {
    const mod = new BrowserModule();
    const ctx = await mod.getContext('sess-sync');
    await mod.syncStorageState(ctx);

    const stateFile = path.join(testAgentsBaseDir, 'agent-b', 'browser-profile', 'shared-state.json');
    expect(fsSync.existsSync(stateFile)).toBe(true);

    const content = JSON.parse(fsSync.readFileSync(stateFile, 'utf-8'));
    expect(content).toHaveProperty('cookies');
    expect(content).toHaveProperty('origins');

    await mod.deleteSession('sess-sync');
  }, 30000);

  it('navigate calls syncStorageState — shared-state.json exists after navigate', async () => {
    const mod = new BrowserModule();
    await mod.navigate('sess-sync', 'about:blank');

    const stateFile = path.join(testAgentsBaseDir, 'agent-b', 'browser-profile', 'shared-state.json');
    expect(fsSync.existsSync(stateFile)).toBe(true);

    await mod.deleteSession('sess-sync');
  }, 30000);
});

// ── T4: VNC state persistence ────────────────────────────────────────────────

describe('BrowserModule - VNC state persistence', () => {
  beforeAll(async () => {
    testAgentsBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-test-'));
  });

  afterAll(async () => {
    await fs.rm(testAgentsBaseDir, { recursive: true, force: true });
  });

  beforeEach(() => setTestEnv('agent-c', 'sess-vnc'));
  afterEach(restoreEnv);

  it('spawnVnc writes vnc-state.json with correct fields', async () => {
    const mod = new BrowserModule();
    const vnc = await (mod as any).spawnVnc('sess-vnc');

    const stateFile = path.join(
      testAgentsBaseDir, 'agent-c', 'browser-sessions', 'sess-vnc', 'vnc-state.json',
    );
    expect(fsSync.existsSync(stateFile)).toBe(true);

    const state = JSON.parse(fsSync.readFileSync(stateFile, 'utf-8'));
    expect(state.display).toBe(vnc.display);
    expect(state.vncPort).toBe(vnc.vncPort);
    expect(state.token).toBe(vnc.token);
    expect(typeof state.pid_xvfb).toBe('number');
    expect(typeof state.pid_x11vnc).toBe('number');

    await mod.deleteSession('sess-vnc');
  }, 15000);

  it('stopVnc removes vnc-state.json', async () => {
    const mod = new BrowserModule();
    await (mod as any).spawnVnc('sess-vnc');

    const stateFile = path.join(
      testAgentsBaseDir, 'agent-c', 'browser-sessions', 'sess-vnc', 'vnc-state.json',
    );
    expect(fsSync.existsSync(stateFile)).toBe(true);

    await (mod as any).stopVnc('sess-vnc');
    expect(fsSync.existsSync(stateFile)).toBe(false);
  }, 15000);

  it('spawnVnc reconnects to live processes without spawning new ones (resume)', async () => {
    const mod = new BrowserModule();
    const vnc1 = await (mod as any).spawnVnc('sess-vnc');
    const pid_xvfb = vnc1.pid_xvfb;
    const pid_x11vnc = vnc1.pid_x11vnc;
    const token = vnc1.token;

    // Simulate subprocess restart: new BrowserModule with same env, same state file on disk
    const mod2 = new BrowserModule();
    const vnc2 = await (mod2 as any).spawnVnc('sess-vnc');

    // Should reconnect — same token, same PIDs, no new processes
    expect(vnc2.token).toBe(token);
    expect(vnc2.pid_xvfb).toBe(pid_xvfb);
    expect(vnc2.pid_x11vnc).toBe(pid_x11vnc);
    expect(vnc2.xvfbProc).toBeNull();
    expect(vnc2.x11vncProc).toBeNull();

    await mod.deleteSession('sess-vnc');
  }, 15000);

  it('spawnVnc respawns when state file PIDs are dead', async () => {
    const mod = new BrowserModule();

    // Write a fake state file with dead PIDs
    const dir = path.join(testAgentsBaseDir, 'agent-c', 'browser-sessions', 'sess-vnc');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'vnc-state.json'), JSON.stringify({
      display: 199, vncPort: 6000, token: 'dead-token',
      pid_xvfb: 99999999, pid_x11vnc: 99999998,
    }));

    const vnc = await (mod as any).spawnVnc('sess-vnc');

    // Should have spawned fresh — different token, real procs
    expect(vnc.token).not.toBe('dead-token');
    expect(vnc.xvfbProc).not.toBeNull();

    await mod.deleteSession('sess-vnc');
  }, 15000);
});

// ── T5: tab state persistence ─────────────────────────────────────────────────

describe('BrowserModule - tab state persistence', () => {
  beforeAll(async () => {
    testAgentsBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-test-'));
  });

  afterAll(async () => {
    await fs.rm(testAgentsBaseDir, { recursive: true, force: true });
  });

  beforeEach(() => setTestEnv('agent-d', 'sess-tabs'));
  afterEach(restoreEnv);

  it('closeSession saves tabs.json with navigated URLs', async () => {
    const mod = new BrowserModule();
    await mod.navigate('sess-tabs', 'https://example.com');
    await mod.closeSession('sess-tabs');

    const tabsFile = path.join(
      testAgentsBaseDir, 'agent-d', 'browser-sessions', 'sess-tabs', 'tabs.json',
    );
    expect(fsSync.existsSync(tabsFile)).toBe(true);
    const { urls } = JSON.parse(fsSync.readFileSync(tabsFile, 'utf-8'));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls[0]).toContain('example.com');
  }, 30000);

  it('deleteSession removes tabs.json along with session dir', async () => {
    const mod = new BrowserModule();
    await mod.navigate('sess-tabs', 'https://example.com');
    await mod.deleteSession('sess-tabs');

    const sessionDir = path.join(testAgentsBaseDir, 'agent-d', 'browser-sessions', 'sess-tabs');
    expect(fsSync.existsSync(sessionDir)).toBe(false);
  }, 30000);
});

// ── VNC session management (existing tests, updated paths) ───────────────────

describe('BrowserModule - VNC session management', () => {
  let mod: BrowserModule;

  beforeAll(async () => {
    testAgentsBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-test-'));
  });

  afterAll(async () => {
    await fs.rm(testAgentsBaseDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    setTestEnv('agent-vnc', 'default');
    mod = new BrowserModule();
  });

  afterEach(async () => {
    await mod.deleteSession('vnc-sess-1').catch(() => {});
    await mod.deleteSession('vnc-sess-2').catch(() => {});
    restoreEnv();
  }, 30000);

  it('spawnVnc returns VNC session with display >= 100 and port >= 5901', async () => {
    const vnc = await (mod as any).spawnVnc('vnc-sess-1');
    expect(vnc.display).toBeGreaterThanOrEqual(100);
    expect(vnc.vncPort).toBeGreaterThanOrEqual(5901);
    expect(vnc.pid_xvfb).toBeGreaterThan(0);
    expect(vnc.pid_x11vnc).toBeGreaterThan(0);
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
    const content = await fs.readFile('/tmp/vnc-tokens.cfg', 'utf-8');
    expect(content).toContain(`${token}:`);
  }, 10000);

  it('token file entry removed after stopVnc', async () => {
    await (mod as any).spawnVnc('vnc-sess-1');
    const token = (mod as any).vncSessions.get('vnc-sess-1')!.token as string;
    await (mod as any).stopVnc('vnc-sess-1');
    const content = await fs.readFile('/tmp/vnc-tokens.cfg', 'utf-8').catch(() => '');
    expect(content).not.toContain(`${token}:`);
  }, 10000);

  it('getContext creates VNC session with display >= 100', async () => {
    await mod.getContext('vnc-sess-1');
    const vnc = (mod as any).vncSessions.get('vnc-sess-1');
    expect(vnc).toBeDefined();
    expect(vnc.display).toBeGreaterThanOrEqual(100);
  }, 30000);
});

// ── U3, U4, U5: session isolation ────────────────────────────────────────────

describe('BrowserModule - session isolation', () => {
  let mod: BrowserModule;

  beforeAll(async () => {
    testAgentsBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-test-'));
  });

  afterAll(async () => {
    await fs.rm(testAgentsBaseDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    setTestEnv('agent-iso', 'default');
    mod = new BrowserModule();
  });

  afterEach(async () => {
    await mod.deleteSession('sess-1').catch(() => {});
    await mod.deleteSession('sess-2').catch(() => {});
    await mod.deleteSession('sess-resume').catch(() => {});
    restoreEnv();
  }, 30000);

  it('U5: creates separate userDataDirs per session under AGENTS_BASE_DIR', async () => {
    await mod.getContext('sess-1');
    await mod.getContext('sess-2');
    const stat1 = await fs.stat(
      path.join(testAgentsBaseDir, 'agent-iso', 'browser-sessions', 'sess-1', 'userDataDir'),
    );
    const stat2 = await fs.stat(
      path.join(testAgentsBaseDir, 'agent-iso', 'browser-sessions', 'sess-2', 'userDataDir'),
    );
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

  it('resumes session after close (localStorage persists in userDataDir)', async () => {
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

// ── Executable path ───────────────────────────────────────────────────────────

describe('BrowserModule - executable path', () => {
  it('U-EXEC1: Google Chrome path is a non-empty string', () => {
    expect(typeof CHROME_PATH).toBe('string');
    expect(CHROME_PATH.length).toBeGreaterThan(0);
  });

  it('U-EXEC2: Google Chrome binary exists on disk', () => {
    expect(fsSync.existsSync(CHROME_PATH)).toBe(true);
  });

  it('U-EXEC3: executable filename contains "chrome"', () => {
    expect(/chrome/i.test(path.basename(CHROME_PATH))).toBe(true);
  });
});
