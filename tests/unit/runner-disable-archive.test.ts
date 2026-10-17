/**
 * disableArchive (#609): an agent that turns the archive off never builds a
 * kb.sqlite, on either spawn path — the channel/API spawn and the orchestration
 * session. Without the switch both paths index the agent's memory.
 *
 * HistoryDB and knowledge are mocked for the same node:sqlite/fts5 reason as
 * api-hard-cap.test.ts — unrelated to the change under test.
 */
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('../../src/history/db', () => ({
  HistoryDB: {
    forDir: jest.fn(() => ({ insertMessage: jest.fn() })),
    forAgent: jest.fn(() => ({ insertMessage: jest.fn() })),
  },
}));

jest.mock('../../src/agent/knowledge', () => ({
  resolveSharedConfig: jest.fn(() => ({ enabled: false })),
  sharedVaultDir: jest.fn(() => '/tmp'),
  spawnArchiveReindex: jest.fn(),
}));

// Capture the deps the runner hands the orchestration runtime, to call createAgentSession directly.
let orchestrationDeps: any;
jest.mock('../../src/orchestration/runtime', () => ({
  AgentOrchestrationRuntime: {
    open: jest.fn(async (...args: any[]) => { orchestrationDeps = args[5]; return { close: async () => {} }; }),
  },
}));

jest.mock('../../src/session/claude-bin', () => ({
  ...jest.requireActual('../../src/session/claude-bin'),
  resolveClaudeBin: () => ({ bin: 'claude', source: 'PATH', searched: [] }),
}));

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: jest.fn(() => {
    const proc = new EventEmitter() as any;
    proc.stdin = { writable: true, write: jest.fn() };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.pid = 12345;
    proc.kill = jest.fn(() => { process.nextTick(() => proc.emit('exit', 0, 'SIGTERM')); return true; });
    return proc;
  }),
}));

import { AgentRunner } from '../../src/agent/runner';
import { spawnArchiveReindex } from '../../src/agent/knowledge';
import { AgentConfig, GatewayConfig } from '../../src/types';

const reindex = spawnArchiveReindex as jest.Mock;
let tmpDir: string;
let runner: AgentRunner | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-disable-archive-'));
  reindex.mockClear();
  orchestrationDeps = undefined;
});

afterEach(async () => {
  await runner?.stop();
  runner = undefined;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeRunner(extra: Partial<AgentConfig>): AgentRunner {
  const workspace = path.join(tmpDir, 'agents', 'family-bot', 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), 'SHARED-CONTEXT');
  const agent: AgentConfig = {
    id: 'family-bot', description: 'test', workspace, env: '',
    telegram: { botToken: 'test-token' },
    claude: { model: 'claude-opus-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
    ...extra,
  };
  const gateway: GatewayConfig = { gateway: { orchestration: false, logDir: path.join(tmpDir, 'logs'), timezone: 'UTC' }, agents: [] };
  runner = new AgentRunner(agent, gateway);
  return runner;
}

/** Drive the channel/API spawn path (runner.spawnSession) until the process is spawned. */
async function spawnViaApi(r: AgentRunner): Promise<void> {
  const spawnMock = require('child_process').spawn as jest.Mock;
  spawnMock.mockClear();
  const callbacks = { onChunk: jest.fn(), onDone: jest.fn(), onError: jest.fn() };
  void r.sendApiMessageStream('sess-1', 'chat-1', 'hello', callbacks, { timeoutMs: 60_000 });
  for (let i = 0; i < 200 && !spawnMock.mock.calls.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(spawnMock).toHaveBeenCalled();
}

/** Drive the orchestration session-creation path (createAgentSession). */
async function spawnViaOrchestration(r: AgentRunner): Promise<void> {
  await (r as any).getOrchestration();
  const session = await orchestrationDeps.createAgentSession('orch-1', {}, undefined, undefined);
  await session?.stop?.();
}

describe('channel/API spawn path', () => {
  it('indexes the archive when disableArchive is unset (baseline)', async () => {
    await spawnViaApi(makeRunner({}));
    expect(reindex).toHaveBeenCalledTimes(1);
  });

  it('never indexes the archive when disableArchive is true', async () => {
    await spawnViaApi(makeRunner({ disableArchive: true }));
    expect(reindex).not.toHaveBeenCalled();
  });
});

describe('orchestration session path', () => {
  it('indexes the archive when disableArchive is unset (baseline)', async () => {
    await spawnViaOrchestration(makeRunner({}));
    expect(reindex).toHaveBeenCalledTimes(1);
  });

  it('never indexes the archive when disableArchive is true', async () => {
    await spawnViaOrchestration(makeRunner({ disableArchive: true }));
    expect(reindex).not.toHaveBeenCalled();
  });
});
