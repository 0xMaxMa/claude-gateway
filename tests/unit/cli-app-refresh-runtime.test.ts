import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
const mockRefresh = jest.fn();
const mockManager = jest.fn();
const mockLocalDocker = jest.fn();
jest.mock('../../src/session/codex-container-runtime', () => ({ assertLocalCodexDocker: () => mockLocalDocker() }));
jest.mock('../../src/apps/agent-container-migration', () => ({ refreshAppAgentRuntime: (...args: unknown[]) => mockRefresh(...args) }));
jest.mock('../../src/apps/agent-manager', () => ({ AgentManager: jest.fn().mockImplementation((...args: unknown[]) => { mockManager(...args); return {}; }) }));
import { runApp } from '../../src/cli/commands/app';

let root: string;
let stderr: jest.SpyInstance, stdout: jest.SpyInstance;
const previousUrl = process.env.CLAUDE_GATEWAY_URL;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'refresh-cli-'));
  writeFileSync(join(root, 'config.json'), JSON.stringify({ agents: [{ id: 'bot', container: 'demo-agent' }] }));
  writeFileSync(join(root, 'apps.json'), JSON.stringify({ apps: [{ name: 'demo', agentDeclaration: { name: 'bot' } }] }));
  delete process.env.CLAUDE_GATEWAY_URL;
  mockRefresh.mockReset().mockResolvedValue(undefined); mockManager.mockClear(); mockLocalDocker.mockReset();
  stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); stderr.mockRestore(); stdout.mockRestore(); });
afterAll(() => { if (previousUrl === undefined) delete process.env.CLAUDE_GATEWAY_URL; else process.env.CLAUDE_GATEWAY_URL = previousUrl; });
test('uses selected local config and sibling app registry without HTTP', async () => {
  expect(await runApp(['refresh-runtime', 'demo'], { config: join(root, 'config.json'), json: true }, {})).toBe(0);
  expect(mockRefresh).toHaveBeenCalledWith(expect.objectContaining({ name: 'demo' }), expect.objectContaining({ id: 'bot' }), expect.anything());
  expect(mockManager).toHaveBeenCalledWith(join(root, 'config.json'), join(root, 'agents'));
  expect(stdout).toHaveBeenCalledWith(expect.stringContaining('runtime-refreshed'));
});
test.each(['flag', 'environment'])('rejects remote %s before local maintenance', async source => {
  if (source === 'environment') process.env.CLAUDE_GATEWAY_URL = 'https://gateway.example';
  expect(await runApp(['refresh-runtime', 'demo'], { config: join(root, 'config.json'), ...(source === 'flag' ? { url: 'https://gateway.example' } : {}) }, {})).toBe(1);
  expect(mockRefresh).not.toHaveBeenCalled();
});
test('propagates stopped-agent precondition as failure, never claims refreshed', async () => {
  mockRefresh.mockRejectedValue(new Error('CONTAINER_REFRESH_STOP_REQUIRED: Drain active work and stop only agent'));
  expect(await runApp(['refresh-runtime', 'demo'], { config: join(root, 'config.json') }, {})).toBe(1);
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('CONTAINER_REFRESH_STOP_REQUIRED'));
  expect(stdout).not.toHaveBeenCalled();
});

test('refuses a remote Docker daemon before manager or refresh mutation', async () => {
  mockLocalDocker.mockImplementation(() => { throw new Error('CODEX_CONTAINER_RUNTIME_UNAVAILABLE: local Linux Docker daemon required'); });
  expect(await runApp(['refresh-runtime', 'demo'], { config: join(root, 'config.json') }, {})).toBe(1);
  expect(mockRefresh).not.toHaveBeenCalled();
  expect(mockManager).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('local Linux Docker daemon required'));
});
