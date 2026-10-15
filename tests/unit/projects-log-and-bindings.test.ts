import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { AgentRunner } from '../../src/agent/runner';
import { GatewayRouter } from '../../src/api/gateway-router';
import { setProjectsLogger } from '../../src/projects/log';
import { startProject } from '../../src/projects/start';
import type { AgentConfig, ApiKey, GatewayConfig, Logger } from '../../src/types';

const KEYS = {
  admin: { key: 'k-admin', agents: '*', admin: true },
  podRead: { key: 'k-ro', agents: '*' },
} satisfies Record<string, ApiKey>;
const A = '/api/v1/agents/alfred';

const sink = () => {
  const warn = jest.fn();
  setProjectsLogger({ debug: jest.fn(), info: jest.fn(), warn, error: jest.fn() } as unknown as Logger);
  return warn;
};
afterEach(() => setProjectsLogger(undefined));

describe('a bindings folder that cannot be read', () => {
  let base: string;
  let runner: AgentRunner;
  let gw: ReturnType<GatewayRouter['getApp']>;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bindings-broken-')));
    const workspace = path.join(base, 'agents', 'alfred', 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(base, 'agents', 'alfred', 'project-bindings'), 'not a folder');
    const cfg: AgentConfig = { id: 'alfred', description: 'a', workspace, env: '', claude: { model: 'm', dangerouslySkipPermissions: true, extraFlags: [] } };
    const gateway: GatewayConfig = {
      gateway: { logDir: path.join(base, 'logs'), timezone: 'UTC', api: { keys: Object.values(KEYS) } },
      agents: [cfg],
    };
    runner = new AgentRunner(cfg, gateway);
    gw = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', cfg]]), undefined, gateway).getApp();
  });
  afterEach(async () => {
    await runner.stop().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('answers a non-admin read with a message about the folder, and logs the reason once', async () => {
    const warn = sink();
    for (const url of [`${A}/chats`, `${A}/chats/api-web/messages`, `${A}/sessions?chat_id=web`, `${A}/chats`]) {
      const res = await request(gw).get(url).set('Authorization', 'Bearer k-ro');
      expect([url, res.status, res.body.code]).toEqual([url, 503, 'project_bindings_unreadable']);
      expect(res.body.error).not.toMatch(/admin API key/);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/project-bindings.*ENOTDIR|ENOTDIR.*project-bindings/s);
  });

  it('leaves an admin read alone', async () => {
    expect((await request(gw).get(`${A}/chats`).set('Authorization', 'Bearer k-admin')).status).toBe(200);
  });
});

describe('a project start that never launched', () => {
  it('logs the message and errno to the gateway logger and returns only the bare reason', async () => {
    const warn = sink();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-fail-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    const sys = { listeners: async () => [], sleep: async () => {} } as never;
    const launcher = async () => { throw Object.assign(new Error('spawn sh ENOENT /secret/path'), { code: 'ENOENT' }); };
    const res = await startProject(sys, launcher as never, { realProject: dir, name: 'site', logPath: path.join(dir, 'x.log') });
    fs.rmSync(dir, { recursive: true, force: true });
    expect(res).toEqual({ ok: false, error: { code: 'start_failed', reason: 'ENOENT' } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ENOENT /secret/path'), { code: 'ENOENT' });
  });
});
