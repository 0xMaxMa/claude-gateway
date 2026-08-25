import express from 'express';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { createApiRouter } from '../../src/api/router';
import { createWorkspaceRouter } from '../../src/api/workspace-router';
import { runCli } from '../../src/cli';
import { AgentConfig, ApiKey } from '../../src/types';

/**
 * End-to-end CLI test for `agents create` and `agents update` — a real Express
 * server mounting the actual wizard/workspace/agents routes, driven through
 * runCli() → http-client, same style as tests/integration/cli-e2e.test.ts and
 * cli-agents-channels-e2e.test.ts.
 *
 * The only things faked are the two boundaries a human/Claude would otherwise
 * occupy: interactive stdin (mocked `../../src/cli/prompt`, scripted per test —
 * readline itself is not the thing under test here) and the Claude subprocess
 * (`child_process.spawn`/`spawnSync`, mocked so tests are deterministic and
 * don't require a live `claude` binary or network). Everything else — HTTP
 * routing, config.json/workspace writes, hot-reloadable in-memory maps — is
 * real.
 */

// ── Mock child_process ────────────────────────────────────────────────────────
// spawn: used server-side by runClaude() for POST /v1/agents/wizard/start.
// spawnSync: used client-side by `agents update`'s regenerate-AGENTS.md path.

jest.mock('child_process', () => {
  const actual = jest.requireActual<typeof import('child_process')>('child_process');
  return { ...actual, spawn: jest.fn(), spawnSync: jest.fn() };
});
import { spawn, spawnSync } from 'child_process';
const mockSpawn = spawn as jest.Mock;
const mockSpawnSync = spawnSync as jest.Mock;

function mockClaudeWizardSuccess(agentsMd: string): void {
  mockSpawn.mockImplementationOnce(() => {
    const stdin = Object.assign(new EventEmitter(), { write: jest.fn(), end: jest.fn() });
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { stdout, stderr, stdin, kill: jest.fn() });
    process.nextTick(() => {
      stdout.emit('data', Buffer.from(`=== AGENTS.md ===\n${agentsMd}`));
      child.emit('close', 0);
    });
    return child;
  });
}

// ── Mock ../../src/cli/prompt — the interactive-input boundary ────────────────

jest.mock('../../src/cli/prompt', () => ({
  createRl: jest.fn(() => ({ close: jest.fn() })),
  ask: jest.fn(),
  askMultiline: jest.fn(),
  previewAndAccept: jest.fn(),
  printFilePreview: jest.fn(),
  editInEditor: jest.fn(),
}));
import { ask, askMultiline, previewAndAccept } from '../../src/cli/prompt';
const mockAsk = ask as jest.Mock;
const mockAskMultiline = askMultiline as jest.Mock;
const mockPreviewAndAccept = previewAndAccept as jest.Mock;

/** Scripts `ask()` to return each answer in order; throws (→ runCli exits 1)
 *  if called more times than scripted, so a wrong code path fails fast instead
 *  of hanging on an unresolved prompt. */
function scriptAsk(...answers: string[]): void {
  let i = 0;
  mockAsk.mockImplementation(async () => {
    if (i >= answers.length) throw new Error(`ask() called more times than scripted (${answers.length}): ${JSON.stringify(answers)}`);
    return answers[i++];
  });
}

// ── Mock global.fetch — pass real requests through to our local test server,
//    intercept only the external Telegram Bot API validation call. ───────────

const realFetch = global.fetch;
beforeAll(() => {
  global.fetch = jest.fn((url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (href.includes('api.telegram.org')) {
      return Promise.resolve({ ok: true, json: async () => ({ ok: true, result: { username: 'wizard_test_bot' } }) } as Response);
    }
    return realFetch(url, init);
  }) as typeof fetch;
});
afterAll(() => {
  global.fetch = realFetch;
});

// ── Server + fixtures ──────────────────────────────────────────────────────────

const KEY = 'e2e-admin-key';
const NO_ACCESS_KEY = 'e2e-no-agents-key';
const EXISTING_AGENT_ID = 'alfred';
const apiKeys: ApiKey[] = [
  { key: KEY, description: 'e2e', agents: '*', admin: true },
  { key: NO_ACCESS_KEY, description: 'e2e scoped to nothing', agents: [], admin: false },
];

let tmpDir: string;
let configPath: string;
let agentConfigs: Map<string, AgentConfig>;
let server: http.Server;
let baseUrl: string;
let stdout: string[];
let writeSpy: jest.SpyInstance;

function existingAgentConfig(): AgentConfig {
  return {
    id: EXISTING_AGENT_ID,
    description: 'Personal assistant',
    workspace: path.join(tmpDir, 'agents', EXISTING_AGENT_ID, 'workspace'),
    env: '',
    claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
    telegram: { botToken: 'tg-existing-token' },
  } as AgentConfig;
}

beforeAll((done) => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-cli-wizard-e2e-'));
  fs.mkdirSync(path.join(tmpDir, 'agents', EXISTING_AGENT_ID, 'workspace'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'agents', EXISTING_AGENT_ID, 'workspace', 'AGENTS.md'),
    '# Agent: Alfred\n\nOriginal description.\n',
  );
  configPath = path.join(tmpDir, 'config.json');
  agentConfigs = new Map([[EXISTING_AGENT_ID, existingAgentConfig()]]);
  fs.writeFileSync(
    configPath,
    JSON.stringify({ gateway: { logDir: '~/logs', timezone: 'UTC', api: { keys: apiKeys } }, agents: [existingAgentConfig()] }, null, 2),
  );

  const app = express();
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use(express.json());
  app.use('/api', createApiRouter(new Map(), agentConfigs, apiKeys, configPath));
  app.use('/api', createWorkspaceRouter(agentConfigs, apiKeys));
  server = app.listen(0, () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
    done();
  });
});

afterAll((done) => {
  server.close(() => done());
});

let stderr: string[];
let stderrSpy: jest.SpyInstance;
let consoleLogSpy: jest.SpyInstance;

beforeEach(() => {
  stdout = [];
  writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(chunk.toString());
    return true;
  });
  // runCreate/runUpdate narrate via console.log (printResult-based commands use
  // process.stdout.write directly, already covered above). Spied independently —
  // and with a full override, not a pass-through — because another test file
  // elsewhere in the suite mocks console.log globally without restoring it, and
  // this must capture real output regardless of what ran before it.
  consoleLogSpy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(' ') + '\n');
  });
  stderr = [];
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(chunk.toString());
    return true;
  });
  mockAsk.mockReset();
  mockAskMultiline.mockReset();
  mockPreviewAndAccept.mockReset();
  mockSpawn.mockClear();
  mockSpawnSync.mockReset();
});

afterEach(() => {
  writeSpy.mockRestore();
  stderrSpy.mockRestore();
  consoleLogSpy.mockRestore();
});

const base = (extra: string[]) => ['--config', '/nonexistent-config.json', '--url', baseUrl, '--key', KEY, ...extra];
const out = () => stdout.join('');
const errOut = () => stderr.join('');

// ─────────────────────────────────────────────────────────────────────────────
// agents create
// ─────────────────────────────────────────────────────────────────────────────

describe('cli e2e — agents create', () => {
  it('happy path via flags: writes workspace + config, skips channel connect', async () => {
    mockClaudeWizardSuccess('# Agent: Newbot\n\nA helpful new bot for the team.\n');
    mockPreviewAndAccept.mockImplementation(async (_rl: unknown, files: Map<string, string>) => files);
    scriptAsk('skip'); // "Connect a channel now?"

    const code = await runCli(['agents', 'create', ...base(['--id', 'newbot', '--description', 'A helpful new bot for the team'])]);

    expect(code).toBe(0);
    expect(out()).toMatch(/Agent "newbot" created/);
    expect(out()).toMatch(/No channel connected yet/);

    const workspaceFile = path.join(tmpDir, 'agents', 'newbot', 'workspace', 'AGENTS.md');
    expect(fs.existsSync(workspaceFile)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { agents: { id: string }[] };
    expect(cfg.agents.find((a) => a.id === 'newbot')).toBeDefined();
  });

  it('interactive id + description prompts (no flags) are honored', async () => {
    mockClaudeWizardSuccess('# Agent: Interactivebot\n\nDescribed entirely over stdin.\n');
    mockPreviewAndAccept.mockImplementation(async (_rl: unknown, files: Map<string, string>) => files);
    mockAskMultiline.mockResolvedValueOnce('Described entirely over stdin.');
    scriptAsk('interactivebot', 'skip'); // id prompt, then "Connect a channel now?"

    const code = await runCli(['agents', 'create', ...base([])]);

    expect(code).toBe(0);
    expect(out()).toMatch(/Agent "interactivebot" created/);
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { agents: { id: string }[] };
    expect(cfg.agents.find((a) => a.id === 'interactivebot')).toBeDefined();
  });

  it('skipping AGENTS.md aborts without creating the agent', async () => {
    mockClaudeWizardSuccess('# Agent: Abortbot\n\nShould never land.\n');
    // Preview/accept returns a map that never included AGENTS.md (simulates a
    // hard skip on a required file, which previewAndAccept forbids — this
    // asserts runCreate's own defense-in-depth check).
    mockPreviewAndAccept.mockImplementation(async () => new Map([['SOUL.md', 'soul only']]));

    const code = await runCli(['agents', 'create', ...base(['--id', 'abortbot', '--description', 'Should never land'])]);

    expect(code).toBe(1);
    expect(errOut()).toMatch(/AGENTS\.md was skipped but is required/);
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { agents: { id: string }[] };
    expect(cfg.agents.find((a) => a.id === 'abortbot')).toBeUndefined();
    expect(fs.existsSync(path.join(tmpDir, 'agents', 'abortbot'))).toBe(false);
  });

  it('missing id (flag empty, prompt empty) fails with exit 1 and no HTTP call', async () => {
    scriptAsk(''); // id prompt answered blank
    const code = await runCli(['agents', 'create', ...base(['--description', 'irrelevant'])]);
    expect(code).toBe(1);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('connects a Telegram channel during create (external validation call intercepted)', async () => {
    mockClaudeWizardSuccess('# Agent: Chatbot\n\nConnects telegram at creation.\n');
    mockPreviewAndAccept.mockImplementation(async (_rl: unknown, files: Map<string, string>) => files);
    scriptAsk('telegram', '123456:fake-validated-token'); // channel choice, then token

    const code = await runCli(['agents', 'create', ...base(['--id', 'chatbot', '--description', 'Connects telegram at creation'])]);

    expect(code).toBe(0);
    expect(out()).toMatch(/Bot @wizard_test_bot connected/);
    expect(out()).toMatch(/channels pending --agent chatbot --channel telegram/);

    // The wizard's channel-connect step writes straight to config.json (writeAgentsToConfig)
    // without touching the harness's in-memory agentConfigs map — that resync is the
    // production file watcher's job, which this router-only harness doesn't run. So verify
    // on disk here, the same way the wizard's own persistence is verified elsewhere.
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { agents: Array<{ id: string; telegram?: { botToken: string } }> };
    expect(cfg.agents.find((a) => a.id === 'chatbot')?.telegram?.botToken).toBe('123456:fake-validated-token');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// agents update
// ─────────────────────────────────────────────────────────────────────────────

describe('cli e2e — agents update', () => {
  it('regenerates AGENTS.md via the client-side Claude call and saves it', async () => {
    mockSpawnSync.mockReturnValueOnce({ error: undefined, status: 0, stdout: '# Agent: Alfred\n\nA freshly regenerated description.\n' });
    scriptAsk('1', 'y', '0'); // Choose: regenerate → Accept? y → Choose: done

    const code = await runCli(['agents', 'update', ...base(['--agent', EXISTING_AGENT_ID])]);

    expect(code).toBe(0);
    expect(mockSpawnSync).toHaveBeenCalledWith('claude', ['--print'], expect.objectContaining({ encoding: 'utf8' }));
    const saved = fs.readFileSync(path.join(tmpDir, 'agents', EXISTING_AGENT_ID, 'workspace', 'AGENTS.md'), 'utf8');
    expect(saved).toMatch(/freshly regenerated description/);
  });

  it('declining the regenerated content leaves the file untouched', async () => {
    const before = fs.readFileSync(path.join(tmpDir, 'agents', EXISTING_AGENT_ID, 'workspace', 'AGENTS.md'), 'utf8');
    mockSpawnSync.mockReturnValueOnce({ error: undefined, status: 0, stdout: '# Agent: Alfred\n\nThis version must be rejected.\n' });
    scriptAsk('1', 'n', '0');

    const code = await runCli(['agents', 'update', ...base(['--agent', EXISTING_AGENT_ID])]);

    expect(code).toBe(0);
    const after = fs.readFileSync(path.join(tmpDir, 'agents', EXISTING_AGENT_ID, 'workspace', 'AGENTS.md'), 'utf8');
    expect(after).toBe(before);
  });

  it('connects a paired-credential channel (LINE) via PATCH', async () => {
    scriptAsk('2', '3', 'line-access-token-fake', 'line-secret-fake', '0');
    // menu order for UPDATE_CHANNELS is telegram(1) discord(2) line(3) slack(4)

    const code = await runCli(['agents', 'update', ...base(['--agent', EXISTING_AGENT_ID])]);

    expect(code).toBe(0);
    expect(out()).toMatch(/LINE connected/);

    stdout.length = 0;
    const listCode = await runCli(['agents', 'list', ...base(['--json'])]);
    expect(listCode).toBe(0);
    const listed = JSON.parse(out()) as { agents: Array<{ id: string; line_connected?: boolean }> };
    expect(listed.agents.find((a) => a.id === EXISTING_AGENT_ID)?.line_connected).toBe(true);
  });

  it('disconnects the seeded telegram channel via PATCH (still first in menu order after LINE was added above)', async () => {
    scriptAsk('3', '1', '0'); // Choose: disconnect → pick telegram (first in UPDATE_CHANNELS order) → done

    const code = await runCli(['agents', 'update', ...base(['--agent', EXISTING_AGENT_ID])]);

    expect(code).toBe(0);
    expect(out()).toMatch(/Telegram disconnected/);

    stdout.length = 0;
    const listCode = await runCli(['agents', 'list', ...base(['--json'])]);
    expect(listCode).toBe(0);
    const listed = JSON.parse(out()) as { agents: Array<{ id: string; telegram_connected: boolean }> };
    expect(listed.agents.find((a) => a.id === EXISTING_AGENT_ID)?.telegram_connected).toBe(false);
  });

  it('an unknown --agent fails fast with no prompts', async () => {
    const code = await runCli(['agents', 'update', ...base(['--agent', 'does-not-exist'])]);
    expect(code).toBe(1);
    expect(mockAsk).not.toHaveBeenCalled();
  });

  it('no accessible agents (key scoped to none) fails without prompting', async () => {
    const code = await runCli(['agents', 'update', '--config', '/nonexistent-config.json', '--url', baseUrl, '--key', NO_ACCESS_KEY]);
    expect(code).toBe(1);
    expect(errOut()).toMatch(/No agents found/);
    expect(mockAsk).not.toHaveBeenCalled();
  });
});
