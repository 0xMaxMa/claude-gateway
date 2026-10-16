/**
 * Multi-tenant isolate mode (#601) through the real SessionProcess spawn path:
 * each conversation's process carries its own tenant memory and no other.
 */
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

import { SessionProcess } from '../../src/session/process';
import { SessionStore } from '../../src/session/store';
import { tenantDir } from '../../src/agent/workspace-loader';
import { AgentConfig, GatewayConfig } from '../../src/types';

let tmpDir: string;
let workspace: string;
let store: SessionStore;
const spawned: SessionProcess[] = [];
const gateway: GatewayConfig = { gateway: { logDir: '/tmp/logs', timezone: 'UTC' }, agents: [] };

function agent(multiTenant?: { enabled: boolean }): AgentConfig {
  return {
    id: 'shared-bot', description: 'test', workspace, env: '',
    telegram: { botToken: 'test-token' },
    claude: { model: 'claude-opus-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
    ...(multiTenant ? { multiTenant } : {}),
  };
}

function writeTenant(chatId: string, memory: string): void {
  const dir = tenantDir(workspace, 'telegram', chatId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), memory);
}

async function start(sp: SessionProcess): Promise<{ args: string[]; env: Record<string, string> }> {
  spawned.push(sp);
  const spawnMock = require('child_process').spawn as jest.Mock;
  spawnMock.mockClear();
  await sp.start();
  const [, args, options] = spawnMock.mock.calls[0];
  return { args, env: options.env };
}

/** The system prompt a spawn receives beyond the CLAUDE.md Claude Code loads from cwd. */
function appendedPrompt(args: string[]): string {
  const at = args.indexOf('--append-system-prompt-file');
  return at < 0 ? '' : fs.readFileSync(args[at + 1], 'utf8');
}

function mcpEnv(args: string[]): Record<string, string> {
  const config = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'));
  return config.mcpServers.gateway.env;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-mt-'));
  workspace = path.join(tmpDir, 'agent', 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), 'SHARED-CONTEXT');
  store = new SessionStore(path.join(tmpDir, 'sessions'));
  writeTenant('111', 'TENANT-A-MEMORY');
  writeTenant('222', 'TENANT-B-MEMORY');
});

afterEach(async () => {
  await Promise.all(spawned.splice(0).map(sp => sp.stop().catch(() => {})));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('channel sessions', () => {
  it("each conversation's spawn carries its own tenant memory only", async () => {
    const a = await start(new SessionProcess('s-a', 'telegram', agent({ enabled: true }), gateway, store, '111'));
    const b = await start(new SessionProcess('s-b', 'telegram', agent({ enabled: true }), gateway, store, '222'));
    expect(appendedPrompt(a.args)).toContain('TENANT-A-MEMORY');
    expect(appendedPrompt(a.args)).not.toContain('TENANT-B');
    expect(appendedPrompt(b.args)).toContain('TENANT-B-MEMORY');
    expect(appendedPrompt(b.args)).not.toContain('TENANT-A');
  });

  it('turns the memory_search/memory_get module off', async () => {
    const { args } = await start(new SessionProcess('s-a', 'telegram', agent({ enabled: true }), gateway, store, '111'));
    expect(mcpEnv(args).GATEWAY_MULTI_TENANT_ISOLATE).toBe('1');
  });

  it('leaves a single-tenant agent unchanged', async () => {
    const { args } = await start(new SessionProcess('s-a', 'telegram', agent(), gateway, store, '111'));
    expect(args).not.toContain('--append-system-prompt-file');
    expect(mcpEnv(args).GATEWAY_MULTI_TENANT_ISOLATE).toBe('');
  });
  it("a stop still waiting on the old process keeps the new spawn's tenant context", async () => {
    const spawnMock = require('child_process').spawn as jest.Mock;
    // allow_tools:false API sessions write no MCP config, so only the tenant file claims .sessions/<id>.
    const sp = new SessionProcess('api-race', 'api', agent({ enabled: true }), gateway, store);
    const first = await start(sp);
    const old = spawnMock.mock.results[0].value;
    old.kill.mockImplementation(() => true); // exits only when the test says so
    const stopping = sp.stop();
    await new Promise(resolve => setImmediate(resolve));
    const second = await start(sp);
    const file = second.args[second.args.indexOf('--append-system-prompt-file') + 1];
    old.emit('exit', 0, 'SIGTERM');
    await stopping;
    expect(first.args).toContain('--append-system-prompt-file');
    expect(fs.existsSync(file)).toBe(true);
  });

  it('refuses an extraFlags --append-system-prompt-file, which would replace the tenant context', async () => {
    // Claude Code keeps only the last --append-system-prompt-file, and extraFlags come after the tenant file.
    for (const flags of [['--append-system-prompt-file', 'extra.md'], ['--append-system-prompt-file=extra.md']]) {
      const config = agent({ enabled: true });
      config.claude.extraFlags = flags;
      const sp = new SessionProcess('s-flags', 'telegram', config, gateway, store, '111');
      spawned.push(sp);
      await expect(sp.start()).rejects.toMatchObject({ code: 'INVALID_EXTRA_FLAGS' });
    }
    // An inline --append-system-prompt is applied alongside the file, so it stays allowed.
    const inline = agent({ enabled: true });
    inline.claude.extraFlags = ['--append-system-prompt', 'Be brief.'];
    const { args } = await start(new SessionProcess('s-inline', 'telegram', inline, gateway, store, '111'));
    expect(appendedPrompt(args)).toContain('TENANT-A-MEMORY');
  });
});

describe('API sessions', () => {
  it('key the tenant by the chat the runner assigns, not by the session', async () => {
    const dir = tenantDir(workspace, 'api', 'web-chat');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), 'WEB-CHAT-MEMORY');
    const sp = new SessionProcess('sess-2', 'api', agent({ enabled: true }), gateway, store);
    sp.tenantChatId = 'web-chat';
    expect(appendedPrompt((await start(sp)).args)).toContain('WEB-CHAT-MEMORY');
  });
});

describe('orchestration agent sessions', () => {
  async function managed(chatId: string, config: AgentConfig): Promise<string> {
    const mcp = path.join(tmpDir, `ticket-${chatId}`, 'mcp.json');
    fs.mkdirSync(path.dirname(mcp), { recursive: true });
    fs.writeFileSync(mcp, '{"mcpServers":{}}');
    const { args } = await start(new SessionProcess(`m-${chatId}`, 'telegram', config, gateway, store, chatId,
      { role: 'agent', mcpConfigPath: mcp, overlay: '' }));
    return appendedPrompt(args);
  }

  it('adds the conversation tenant to the workspace context', async () => {
    const a = await managed('111', agent({ enabled: true }));
    expect(a).toContain('SHARED-CONTEXT');
    expect(a).toContain('TENANT-A-MEMORY');
    expect(a).not.toContain('TENANT-B');
    expect(await managed('222', agent({ enabled: true }))).not.toContain('TENANT-A');
  });

  it('reads only CLAUDE.md when isolate mode is off', async () => {
    const context = await managed('111', agent());
    expect(context).toContain('SHARED-CONTEXT');
    expect(context).not.toContain('TENANT-');
  });
});
