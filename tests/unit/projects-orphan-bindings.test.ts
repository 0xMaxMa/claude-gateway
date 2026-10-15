import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('../../src/whatsapp/manager', () => ({
  WhatsAppManager: jest.fn().mockImplementation(() => ({
    stop: jest.fn(), resumeIfLinked: jest.fn(async () => {}), getStatus: jest.fn(() => ({ status: 'unlinked' })), updateAgentConfig: jest.fn(),
  })),
}));
jest.mock('child_process', () => ({ ...jest.requireActual('child_process'), spawn: jest.fn(() => { throw new Error('no spawn in this suite'); }) }));

import { AgentRunner } from '../../src/agent/runner';
import { SessionStore } from '../../src/session/store';
import type { AgentConfig, GatewayConfig } from '../../src/types';

let base: string;
let runner: AgentRunner;
const bindings = () => path.join(base, 'agents', 'alfred', 'project-bindings');
const bindingFiles = () => (fs.existsSync(bindings()) ? fs.readdirSync(bindings()).sort() : []);

function config(): [AgentConfig, GatewayConfig] {
  const workspace = path.join(base, 'agents', 'alfred', 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const cfg: AgentConfig = { id: 'alfred', description: 'a', workspace, env: '', claude: { model: 'm', dangerouslySkipPermissions: true, extraFlags: [] } };
  return [cfg, { gateway: { logDir: path.join(base, 'logs'), timezone: 'UTC', projects: { root: path.join(base, 'projects') } }, agents: [cfg] }];
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-bindings-')));
});
afterEach(async () => {
  await runner?.stop().catch(() => {});
  fs.rmSync(base, { recursive: true, force: true });
});

describe('the binding sweep at gateway start', () => {
  it('removes a binding whose session is gone and keeps one whose session exists', async () => {
    const store = new SessionStore(path.join(base, 'agents'));
    const live = await store.createTelegramSession('alfred', 'web', 'live', 'api', 'site');
    fs.writeFileSync(path.join(bindings(), 'stray-session.json'), '{"project":"site"}\n');
    fs.writeFileSync(path.join(bindings(), 'garbage.json'), 'not json');
    expect(bindingFiles()).toEqual([`${live.id}.json`, 'garbage.json', 'stray-session.json'].sort());

    const [cfg, gateway] = config();
    runner = new AgentRunner(cfg, gateway);
    await runner.start();

    expect(bindingFiles()).toEqual([`${live.id}.json`]);
    expect((await runner.apiSessionBinding(live.id)).kind).toBe('bound');
  });

  it('removes nothing when a session index cannot be read', async () => {
    const store = new SessionStore(path.join(base, 'agents'));
    const live = await store.createTelegramSession('alfred', 'web', 'live', 'api', 'site');
    fs.writeFileSync(path.join(bindings(), 'stray-session.json'), '{"project":"site"}\n');
    fs.writeFileSync(path.join(base, 'agents', 'alfred', 'sessions', 'api-web', 'index.json'), '{ broken');

    const [cfg, gateway] = config();
    runner = new AgentRunner(cfg, gateway);
    await expect(runner.start()).resolves.toBeUndefined();

    expect(bindingFiles()).toEqual([`${live.id}.json`, 'stray-session.json']);
  });

  it('starts without a bindings folder', async () => {
    const [cfg, gateway] = config();
    runner = new AgentRunner(cfg, gateway);
    await expect(runner.start()).resolves.toBeUndefined();
  });
});
