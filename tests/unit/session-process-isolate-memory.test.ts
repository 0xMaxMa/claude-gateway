/**
 * Isolated memory mode (#601) through the real SessionProcess spawn path:
 * each conversation's process carries its own memory and no other.
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

// A conversation sandbox (#609) is a docker container; only its name matters here.
jest.mock('../../src/apps/conversation-sandbox', () => {
  const actual = jest.requireActual('../../src/apps/conversation-sandbox');
  return { ...actual, sandboxPool: { ensure: jest.fn(async (agent: any, conversation: any) => actual.sandboxContainerName(agent, conversation)) } };
});
jest.mock('../../src/orchestration/container', () => ({
  ...jest.requireActual('../../src/orchestration/container'),
  containerNode: jest.fn(async () => ''),
}));
jest.mock('../../src/config/claude-settings', () => ({
  ...jest.requireActual('../../src/config/claude-settings'),
  readClaudeSettings: () => ({ mcpServers: { 'operator-fs': { command: 'fs-server' } } }),
}));

import { SessionProcess } from '../../src/session/process';
import { sandboxContainerName } from '../../src/apps/conversation-sandbox';
import { SessionStore } from '../../src/session/store';
import { chatMemoryDir } from '../../src/agent/workspace-loader';
import { AgentConfig, GatewayConfig } from '../../src/types';

let tmpDir: string;
let workspace: string;
let store: SessionStore;
const spawned: SessionProcess[] = [];
const gateway: GatewayConfig = { gateway: { logDir: '/tmp/logs', timezone: 'UTC' }, agents: [] };

function agent(isolateMemory?: boolean): AgentConfig {
  return {
    id: 'shared-bot', description: 'test', workspace, env: '',
    telegram: { botToken: 'test-token' },
    claude: { model: 'claude-opus-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
    ...(isolateMemory ? { isolateMemory } : {}),
  };
}

function writeChatMemory(chatId: string, memory: string): void {
  const dir = chatMemoryDir(workspace, 'telegram', chatId);
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-iso-'));
  workspace = path.join(tmpDir, 'agent', 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), 'SHARED-CONTEXT');
  store = new SessionStore(path.join(tmpDir, 'sessions'));
  writeChatMemory('111', 'CHAT-A-MEMORY');
  writeChatMemory('222', 'CHAT-B-MEMORY');
});

afterEach(async () => {
  await Promise.all(spawned.splice(0).map(sp => sp.stop().catch(() => {})));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('channel sessions', () => {
  it("each conversation's spawn carries its own memory only", async () => {
    const a = await start(new SessionProcess('s-a', 'telegram', agent(true), gateway, store, '111'));
    const b = await start(new SessionProcess('s-b', 'telegram', agent(true), gateway, store, '222'));
    expect(appendedPrompt(a.args)).toContain('CHAT-A-MEMORY');
    expect(appendedPrompt(a.args)).not.toContain('CHAT-B');
    expect(appendedPrompt(b.args)).toContain('CHAT-B-MEMORY');
    expect(appendedPrompt(b.args)).not.toContain('CHAT-A');
  });

  it('turns the memory_search/memory_get module off', async () => {
    const { args } = await start(new SessionProcess('s-a', 'telegram', agent(true), gateway, store, '111'));
    expect(mcpEnv(args).GATEWAY_ISOLATE_MEMORY).toBe('1');
  });

  it("turns Claude Code's auto memory off: its one directory per cwd is loaded into every conversation's session", async () => {
    const { env } = await start(new SessionProcess('s-a', 'telegram', agent(true), gateway, store, '111'));
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
  });

  it('locks channel tools to this chat and its media directory', async () => {
    const env = mcpEnv((await start(new SessionProcess('s-a', 'telegram', agent(true), gateway, store, '111'))).args);
    expect(env.GATEWAY_ORIGIN_CHAT_ID).toBe('111');
    expect(env.GATEWAY_SESSION_MEDIA_DIR).toBe(path.join(tmpDir, 'agent', 'media', 'telegram-111'));
  });

  it("injects none of the operator's MCP servers or connectors (default deny)", async () => {
    const isolated = JSON.parse(fs.readFileSync((await start(new SessionProcess('s-a', 'telegram', agent(true), gateway, store, '111'))).args.find((_, i, a) => a[i - 1] === '--mcp-config')!, 'utf8'));
    expect(Object.keys(isolated.mcpServers)).toEqual(['gateway']);
    const shared = JSON.parse(fs.readFileSync((await start(new SessionProcess('s-b', 'telegram', agent(), gateway, store, '222'))).args.find((_, i, a) => a[i - 1] === '--mcp-config')!, 'utf8'));
    expect(Object.keys(shared.mcpServers)).toContain('operator-fs');
  });

  it('hands an isolated agent only a non-admin API key scoped to it', async () => {
    const keyed = (keys: any[]): GatewayConfig => ({ gateway: { ...gateway.gateway, api: { keys } }, agents: [] });
    const admin = { key: 'k-admin', admin: true, agents: '*' }, wildcard = { key: 'k-all', agents: '*' }, scoped = { key: 'k-bot', agents: ['shared-bot'] };
    const key = async (config: AgentConfig, keys: any[]) => mcpEnv((await start(new SessionProcess(`k-${keys.length}-${config.isolateMemory ? 1 : 0}`, 'telegram', config, keyed(keys), store, '111'))).args).GATEWAY_API_KEY;
    expect(await key(agent(true), [admin, wildcard, scoped])).toBe('k-bot');
    expect(await key(agent(true), [admin, wildcard])).toBe('');
    expect(await key(agent(), [admin, wildcard])).toBe('k-admin');
  });

  it('leaves an agent without isolateMemory unchanged', async () => {
    const { args, env } = await start(new SessionProcess('s-a', 'telegram', agent(), gateway, store, '111'));
    expect(args).not.toContain('--append-system-prompt-file');
    expect(mcpEnv(args).GATEWAY_ISOLATE_MEMORY).toBe('');
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe(process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY);
  });
  it("a stop still waiting on the old process keeps the new spawn's chat memory", async () => {
    const spawnMock = require('child_process').spawn as jest.Mock;
    // allow_tools:false API sessions write no MCP config, so only the chat memory file claims .sessions/<id>.
    const sp = new SessionProcess('api-race', 'api', agent(true), gateway, store);
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

  it('applies an extraFlags --append-system-prompt alongside the chat memory', async () => {
    // Claude Code applies an inline prompt and a prompt file together (only a second file replaces the first).
    const inline = agent(true);
    inline.claude.extraFlags = ['--append-system-prompt', 'Be brief.'];
    const { args } = await start(new SessionProcess('s-inline', 'telegram', inline, gateway, store, '111'));
    expect(args).toContain('Be brief.');
    expect(appendedPrompt(args)).toContain('CHAT-A-MEMORY');
  });
});

describe('app agent, classic container session', () => {
  // Claude runs in the app container, which mounts the workspace at /workspace.
  function appAgent(isolateMemory?: boolean): AgentConfig {
    return { ...agent(isolateMemory), id: 'app-bot', type: 'app-agent', container: 'demo-agent' };
  }

  const containerNode = () => require('../../src/orchestration/container').containerNode as jest.Mock;

  it("executes in its conversation's own sandbox, never the shared app container (#609)", async () => {
    const a = await start(new SessionProcess('c-a', 'telegram', appAgent(true), gateway, store, '111'));
    const b = await start(new SessionProcess('c-b', 'telegram', appAgent(true), gateway, store, '222'));
    const target = (args: string[]) => args.find(arg => arg.startsWith('demo-agent'));
    expect(a.args[0]).toBe('exec');
    expect(target(a.args)).toBe(sandboxContainerName(appAgent(true), { source: 'telegram', chatId: '111' }));
    expect(target(b.args)).toBe(sandboxContainerName(appAgent(true), { source: 'telegram', chatId: '222' }));
    expect(target(a.args)).not.toBe(target(b.args));
  });

  it("writes the chat memory into the sandbox's own /tmp, not the shared workspace", async () => {
    containerNode().mockClear();
    const { args } = await start(new SessionProcess('c-a', 'telegram', appAgent(true), gateway, store, '111'));
    const file = args[args.indexOf('--append-system-prompt-file') + 1];
    expect(file).toBe('/tmp/gateway-session-c-a/chat-memory.md');
    const [container, , [target], prompt] = containerNode().mock.calls[0];
    expect(container).toBe(sandboxContainerName(appAgent(true), { source: 'telegram', chatId: '111' }));
    expect(target).toBe(file);
    expect(prompt).toContain('CHAT-A-MEMORY');
    expect(prompt).not.toContain('CHAT-B');
    expect(prompt).toContain(path.join(chatMemoryDir('/workspace', 'telegram', '111'), 'MEMORY.md'));
    expect(prompt).not.toContain(workspace);
    expect(fs.existsSync(path.join(workspace, '.sessions', 'c-a', 'chat-memory.md'))).toBe(false);
  });

  it('puts no API key, channel token or gateway address within its reach', async () => {
    const before = process.env.GATEWAY_API_URL;
    process.env.GATEWAY_API_URL = 'http://gateway.example:10850';
    try {
      const { args } = await start(new SessionProcess('c-a', 'telegram', appAgent(true), gateway, store, '111'));
      const flags = args.slice(0, args.findIndex(arg => arg.startsWith('demo-agent')));
      expect(args).not.toContain('--mcp-config');
      expect(flags).not.toContain('TELEGRAM_BOT_TOKEN');
      expect(flags.join(' ')).not.toContain('GATEWAY_API_URL');
      expect(fs.existsSync(path.join(workspace, '.sessions', 'c-a', 'mcp-config.json'))).toBe(false);
    } finally {
      if (before === undefined) delete process.env.GATEWAY_API_URL; else process.env.GATEWAY_API_URL = before;
    }
  });

  it("turns auto memory off inside the container, where every conversation's session shares /workspace", async () => {
    const { args } = await start(new SessionProcess('c-a', 'telegram', appAgent(true), gateway, store, '111'));
    expect(args.slice(0, args.findIndex(arg => arg.startsWith('demo-agent')))).toContain('CLAUDE_CODE_DISABLE_AUTO_MEMORY=1');
  });

  it('stays shared without the app opting in, even next to an isolated host agent', async () => {
    await start(new SessionProcess('h-a', 'telegram', agent(true), gateway, store, '111'));
    const { args } = await start(new SessionProcess('c-a', 'telegram', appAgent(), gateway, store, '111'));
    expect(args).toContain('demo-agent');
    expect(args).not.toContain('--append-system-prompt-file');
    expect(args.join(' ')).not.toContain('CLAUDE_CODE_DISABLE_AUTO_MEMORY');
  });
});

describe('API sessions', () => {
  it('key the memory by the chat the runner assigns, not by the session', async () => {
    const dir = chatMemoryDir(workspace, 'api', 'web-chat');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), 'WEB-CHAT-MEMORY');
    const sp = new SessionProcess('sess-2', 'api', agent(true), gateway, store, undefined, undefined, 'web-chat');
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

  it("adds the conversation's memory to the workspace context", async () => {
    const a = await managed('111', agent(true));
    expect(a).toContain('SHARED-CONTEXT');
    expect(a).toContain('CHAT-A-MEMORY');
    expect(a).not.toContain('CHAT-B');
    expect(await managed('222', agent(true))).not.toContain('CHAT-A');
  });

  it('reads only CLAUDE.md when isolate mode is off', async () => {
    const context = await managed('111', agent());
    expect(context).toContain('SHARED-CONTEXT');
    expect(context).not.toContain('CHAT-');
  });

  it("turns Claude Code's auto memory off for workers too: they run in a cwd every conversation's tasks share", async () => {
    const mcp = path.join(tmpDir, 'worker-ticket', 'mcp.json');
    fs.mkdirSync(path.dirname(mcp), { recursive: true });
    fs.writeFileSync(mcp, '{"mcpServers":{}}');
    const { env } = await start(new SessionProcess('w-111', 'telegram', agent(true), gateway, store, '111',
      { role: 'worker', mcpConfigPath: mcp, overlay: '', context: 'WORKER-CONTEXT' }));
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
  });
});
