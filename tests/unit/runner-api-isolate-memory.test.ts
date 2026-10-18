/**
 * Isolated memory mode (#601) on the plain API path: a web chat holds many
 * sessions, so a spawn must key its isolated memory by the chat, as the
 * orchestration API path does, and never by the session.
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
import { chatMemoryDir } from '../../src/agent/workspace-loader';
import { AgentConfig, GatewayConfig } from '../../src/types';

let tmpDir: string;
let runner: AgentRunner;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-api-isolate-memory-'));
  const workspace = path.join(tmpDir, 'agents', 'shared-bot', 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), 'SHARED-CONTEXT');
  const dir = chatMemoryDir(workspace, 'api', 'web-chat');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), 'WEB-CHAT-MEMORY');
  const agent: AgentConfig = {
    id: 'shared-bot', description: 'test', workspace, env: '',
    telegram: { botToken: 'test-token' },
    claude: { model: 'claude-opus-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
    isolateMemory: true,
  };
  const gateway: GatewayConfig = { gateway: { orchestration: false, logDir: path.join(tmpDir, 'logs'), timezone: 'UTC' }, agents: [] };
  runner = new AgentRunner(agent, gateway);
});

afterEach(async () => {
  await runner.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** The chat memory a session's spawn appended, read when the spawn happens. */
async function spawnedChatMemory(sessionId: string): Promise<string> {
  const spawnMock = require('child_process').spawn as jest.Mock;
  spawnMock.mockClear();
  const callbacks = { onChunk: jest.fn(), onDone: jest.fn(), onError: jest.fn() };
  void runner.sendApiMessageStream(sessionId, 'web-chat', 'hello', callbacks, { timeoutMs: 60_000 });
  for (let i = 0; i < 200 && !spawnMock.mock.calls.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const args: string[] = spawnMock.mock.calls[0][1];
  return fs.readFileSync(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8');
}

test("every session of a web chat gets that chat's memory", async () => {
  expect(await spawnedChatMemory('sess-1')).toContain('WEB-CHAT-MEMORY');
  expect(await spawnedChatMemory('sess-2')).toContain('WEB-CHAT-MEMORY');
});
