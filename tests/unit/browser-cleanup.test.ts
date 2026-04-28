import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { BrowserModule } from '../../mcp/tools/browser/module';

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

let testAgentsBaseDir: string;
let savedEnv: Record<string, string | undefined>;

function setTestEnv(agentId = 'cleanup-agent', sessionId = 'default') {
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

beforeAll(async () => {
  testAgentsBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-cleanup-test-'));
});

afterAll(async () => {
  await fs.rm(testAgentsBaseDir, { recursive: true, force: true });
});

describe('BrowserModule - auto-cleanup', () => {
  beforeEach(() => setTestEnv());
  afterEach(restoreEnv);

  it('U7: closes idle sessions but keeps session dir on disk', async () => {
    const mod = new BrowserModule();
    const SID = 'sess-idle';

    await mod.getContext(SID);
    // Simulate idle by backdating last activity
    (mod as any)['lastActivity'].set(SID, Date.now() - (SESSION_TIMEOUT_MS + 1000));

    await mod.runCleanup();

    expect((mod as any)['contexts'].has(SID)).toBe(false);

    // Session dir still on disk (closeSession preserves it)
    const sessionDir = path.join(testAgentsBaseDir, 'cleanup-agent', 'browser-sessions', SID);
    const stat = await fs.stat(sessionDir);
    expect(stat.isDirectory()).toBe(true);

    await mod.deleteSession(SID).catch(() => {});
  }, 30000);

  it('U8: does not close active sessions', async () => {
    const mod = new BrowserModule();
    const SID = 'sess-active';

    await mod.getContext(SID);
    (mod as any)['lastActivity'].set(SID, Date.now());

    await mod.runCleanup();

    expect((mod as any)['contexts'].has(SID)).toBe(true);

    await mod.deleteSession(SID);
  }, 30000);

  it('deleteSession removes session dir entirely', async () => {
    const mod = new BrowserModule();
    const SID = 'sess-delete';

    await mod.getContext(SID);
    await mod.deleteSession(SID);

    const sessionDir = path.join(testAgentsBaseDir, 'cleanup-agent', 'browser-sessions', SID);
    await expect(fs.stat(sessionDir)).rejects.toThrow();
  }, 30000);
});
