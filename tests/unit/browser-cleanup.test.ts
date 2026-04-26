import * as path from 'path';
import * as fs from 'fs/promises';
import { BrowserModule } from '../../mcp/tools/browser/module';

const SESSION_BASE_DIR = '/tmp/browser-sessions';
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

describe('BrowserModule - auto-cleanup', () => {
  it('U7: closes idle sessions but keeps disk', async () => {
    const mod = new BrowserModule();
    const SID = 'sess-idle';

    await mod.getContext(SID);
    // Simulate idle by backdating last activity
    (mod as any)['lastActivity'].set(SID, Date.now() - (SESSION_TIMEOUT_MS + 1000));

    await mod.runCleanup();

    expect((mod as any)['contexts'].has(SID)).toBe(false);
    const stat = await fs.stat(path.join(SESSION_BASE_DIR, SID));
    expect(stat.isDirectory()).toBe(true);

    await fs.rm(path.join(SESSION_BASE_DIR, SID), { recursive: true, force: true });
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
});
