import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { agentsDirForConfig, loadAgentEnvFiles } from '../../src/config/agent-env';

// ---------------------------------------------------------------------------
// U-AE: per-agent .env → process.env folding (issue #427)
//
// `loadConfig()` interpolates ${VAR} from `process.env` alone, so these files
// are the only way a token written by MCP `agent_create` / `agent_update`
// reaches a running gateway. Two rules have to hold at once:
//
//   - a value the operator exported must never be clobbered by a file, and
//   - a value this module itself copied out of a file is a cache of that file,
//     so a rotated token must take effect on the next reload rather than the
//     process serving the revoked one until it restarts.
//
// Both look identical in `process.env`; only the ledger tells them apart.
// ---------------------------------------------------------------------------
describe('agent-env', () => {
  const OWNED_VARS = ['ACME_BOT_TOKEN', 'ACME_DISCORD_TOKEN', 'SHARED_TOKEN'];
  let tmpDir: string;
  let agentsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-test-'));
    agentsDir = path.join(tmpDir, 'agents');
    for (const v of OWNED_VARS) delete process.env[v];
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const v of OWNED_VARS) delete process.env[v];
  });

  /** Write agents/<id>/.env under the temp gateway root. */
  function writeAgentEnv(agentId: string, contents: string): void {
    const dir = path.join(agentsDir, agentId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.env'), contents);
  }

  it('U-AE-01: derives the agents dir as the sibling of config.json', () => {
    expect(agentsDirForConfig('/srv/gw/config.json')).toBe('/srv/gw/agents');
  });

  it('U-AE-02: folds a new agent .env into process.env', () => {
    writeAgentEnv('acme', 'ACME_BOT_TOKEN=token-a\n# comment\n\nACME_DISCORD_TOKEN=disc-a\n');

    loadAgentEnvFiles(agentsDir);

    expect(process.env.ACME_BOT_TOKEN).toBe('token-a');
    expect(process.env.ACME_DISCORD_TOKEN).toBe('disc-a');
  });

  it('U-AE-03: never overwrites a variable the operator exported', () => {
    process.env.ACME_BOT_TOKEN = 'from-operator';
    writeAgentEnv('acme', 'ACME_BOT_TOKEN=from-dotenv\n');

    loadAgentEnvFiles(agentsDir);
    // Still loses on a later pass — ownership is never acquired for this key.
    writeAgentEnv('acme', 'ACME_BOT_TOKEN=from-dotenv-rotated\n');
    loadAgentEnvFiles(agentsDir);

    expect(process.env.ACME_BOT_TOKEN).toBe('from-operator');
  });

  it('U-AE-04: picks up a rotated token from the file it originally loaded', () => {
    // What `agent_update` remove_channel + add_channel leaves on disk: the old
    // line stripped, the new token appended under the same variable name.
    writeAgentEnv('acme', 'ACME_BOT_TOKEN=token-a\n');
    loadAgentEnvFiles(agentsDir);
    expect(process.env.ACME_BOT_TOKEN).toBe('token-a');

    writeAgentEnv('acme', 'ACME_BOT_TOKEN=token-b\n');
    loadAgentEnvFiles(agentsDir);

    expect(process.env.ACME_BOT_TOKEN).toBe('token-b');
  });

  it('U-AE-05: stops refreshing a variable once something else assigns to it', () => {
    writeAgentEnv('acme', 'ACME_BOT_TOKEN=token-a\n');
    loadAgentEnvFiles(agentsDir);

    // A runtime assignment is indistinguishable from an operator export, and
    // outranks the file for the same reason.
    process.env.ACME_BOT_TOKEN = 'set-at-runtime';
    writeAgentEnv('acme', 'ACME_BOT_TOKEN=token-b\n');
    loadAgentEnvFiles(agentsDir);

    expect(process.env.ACME_BOT_TOKEN).toBe('set-at-runtime');
  });

  it('U-AE-06: a second agent .env cannot hijack a key another one owns', () => {
    // First loaded wins, and keeps winning: ownership is per (key, file), so a
    // later agent declaring the same variable is treated like any other value
    // already in process.env. Without the file check it would take the key
    // over on the next reload and quietly re-point the first agent's channel.
    writeAgentEnv('acme', 'SHARED_TOKEN=from-acme\n');
    loadAgentEnvFiles(agentsDir);
    expect(process.env.SHARED_TOKEN).toBe('from-acme');

    writeAgentEnv('other', 'SHARED_TOKEN=from-other\n');
    loadAgentEnvFiles(agentsDir);

    expect(process.env.SHARED_TOKEN).toBe('from-acme');
  });

  it('U-AE-07: survives a missing dir, an unreadable file and a bad line', () => {
    expect(() => loadAgentEnvFiles(path.join(tmpDir, 'nope'))).not.toThrow();

    // A directory where the .env should be: readFileSync throws EISDIR, and one
    // bad agent must not stop the others from loading.
    fs.mkdirSync(path.join(agentsDir, 'broken', '.env'), { recursive: true });
    writeAgentEnv('acme', 'not-a-pair\n=novalue\nACME_BOT_TOKEN=token-a\n');

    expect(() => loadAgentEnvFiles(agentsDir)).not.toThrow();
    expect(process.env.ACME_BOT_TOKEN).toBe('token-a');
  });
});
