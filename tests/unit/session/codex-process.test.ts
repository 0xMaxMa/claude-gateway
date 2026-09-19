import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, access } from 'fs/promises';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import { CodexProcess, CodexProcessOptions, cleanupCodexSessions } from '../../../src/session/codex-process';
import { TurnUsageCollector } from '../../../src/orchestration/token-usage';
import { prepareContainerProfile, containerNode, stopContainerProfile } from '../../../src/orchestration/container';
import { stopProcessGroup } from '../../../src/orchestration/process-supervisor';
jest.mock('../../../src/orchestration/container', () => ({ ...jest.requireActual('../../../src/orchestration/container'), prepareContainerProfile: jest.fn(), containerNode: jest.fn(), stopContainerProfile: jest.fn().mockResolvedValue(true) }));
jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('../../../src/orchestration/process-supervisor', () => ({ stopProcessGroup: jest.fn().mockResolvedValue(true) }));
const thread = '12345678-1234-1234-1234-123456789abc';
const tick = () => new Promise(resolve => setImmediate(resolve));
let directory: string;
let options: CodexProcessOptions;
let child: any;
let adapter: CodexProcess;
let events: any[];
let rpc: any[];
let turnNumber: number;
function emit(event: any) { child.stdout.write(JSON.stringify(event) + '\n'); }
function notify(method: string, params: any) { emit({ method, params: { threadId: thread, ...params } }); }
function item(value: any, completed = true) { notify(completed ? 'item/completed' : 'item/started', { turnId: 'turn-1', item: value }); }
async function waitUntil(predicate: () => boolean) { const deadline = Date.now() + 2000; while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)); } throw new Error('Condition was not reached'); }

async function launch() { await adapter.start(); adapter.sendMessage('do the task'); await waitUntil(() => rpc.some(r => r.method === 'turn/start')); }
beforeEach(async () => {
  jest.clearAllMocks();
  directory = await mkdtemp(join(tmpdir(), 'codex-adapter-'));
  await writeFile(join(directory, 'mcp.json'), JSON.stringify({ mcpServers: { gateway: { command: 'node', args: ['bridge.js'], env: { TICKET: 'secret-ticket' } } } }));
  process.env.TEST_CODEX_KEY = 'api-secret';
  options = { agent: { workspace: directory } as any, gateway: {} as any, profile: { role: 'worker', mcpConfigPath: join(directory, 'mcp.json'), overlay: 'worker rules', context: 'agent context' }, sessionId: 'logical-session', stateDirectory: directory, config: { model: 'gpt-test', apiKeyEnv: 'TEST_CODEX_KEY', baseUrl: 'https://responses.example/v1' } };
  child = new EventEmitter(); child.pid = 54321; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = jest.fn();
  rpc = []; turnNumber = 0;
  child.stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().trim().split('\n')) {
      const request = JSON.parse(line); rpc.push(request);
      if (request.id === undefined) continue;
      const result = request.method === 'config/read' ? { layers: [], config: { model_provider: 'gateway', model_providers: { gateway: { base_url: options.config.baseUrl, env_key: options.config.apiKeyEnv, wire_api: 'responses' } }, mcp_servers: options.agent.type === 'app-agent' ? { gateway: { command: 'node', args: ['container-bridge.js'] } } : { gateway: { command: 'node', args: ['bridge.js'], env: { TICKET: 'secret-ticket' } } } } } : request.method === 'thread/start' || request.method === 'thread/resume' ? { thread: { id: thread } } : request.method === 'turn/start' ? { turn: { id: 'turn-' + (++turnNumber) } } : {};
      setImmediate(() => { emit({ id: request.id, result }); if (request.method === 'turn/start') notify('turn/started', result); });
    }
  });
  (spawn as jest.Mock).mockReturnValue(child);
  adapter = new CodexProcess(options); events = []; adapter.on('output', line => events.push(JSON.parse(line)));
});
afterEach(async () => { await adapter.stop(); await rm(directory, { recursive: true, force: true }); delete process.env.TEST_CODEX_KEY; });
test('uses private Responses configuration, MCP ticket env and sandbox without credential argv', async () => {
  await launch();
  const [bin, args, settings] = (spawn as jest.Mock).mock.calls[0];
  expect(bin).toBe('codex'); expect(args).toEqual(['app-server', '--listen', 'stdio://']);
  expect(JSON.stringify(args)).not.toMatch(/secret/);
  const config = await readFile(join(settings.env.CODEX_HOME, 'config.toml'), 'utf8');
  expect(config).toContain('sandbox_mode = "workspace-write"');
  expect(config).toContain('env_key = "TEST_CODEX_KEY"'); expect(config).not.toContain('api-secret');
  expect(config).toContain('"TICKET" = "secret-ticket"');
  expect(config).toContain('developer_instructions = "agent context\\n\\nworker rules"');
  expect(settings.env.ANTHROPIC_API_KEY).toBeUndefined();
});
test('maps tools and failures, returns only canonical final and counts cached input once', async () => {
  await launch();
  item({ id: 'comment', type: 'agentMessage', phase: 'commentary', text: 'working' });
  item({ id: 'cmd', type: 'commandExecution', command: 'false' }, false);
  item({ id: 'cmd', type: 'commandExecution', command: 'false', exitCode: 1, status: 'completed', aggregatedOutput: 'failed command' });
  item({ id: 'edit', type: 'fileChange', changes: [{ path: 'a', kind: 'update' }], status: 'completed' });
  item({ id: 'mcp', type: 'mcpToolCall', server: 'gateway', tool: 'task_report_progress', arguments: { text: 'done' }, status: 'failed', error: { message: 'denied' } });
  item({ id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'Finished.' });
  notify('thread/tokenUsage/updated', { turnId: 'turn-1', tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 70, outputTokens: 20, reasoningOutputTokens: 10 } } });
  notify('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  await waitUntil(() => events.some(e => e.type === 'result'));
  expect(events.filter(e => e.type === 'assistant').map(e => e.message.content[0].name)).toEqual(['Bash', 'Edit', 'mcp__gateway__task_report_progress']);
  expect(events.filter(e => e.type === 'user').map(e => e.message.content[0].is_error)).toEqual([true, false, true]);
  expect(events.filter(e => e.type === 'result')).toEqual([expect.objectContaining({ result: 'Finished.' })]);
  const usage = new TurnUsageCollector(); events.forEach(e => usage.observe(e));
  expect(usage.snapshot()).toMatchObject({ loadedTools: null, contextTools: null, requests: [], usage: { inputTokens: 30, cacheReadTokens: 70, outputTokens: 20, totalTokens: 120 } });
});
test('resumes the bound thread explicitly with fresh configuration', async () => {
  await launch();
  const oldHome = (spawn as jest.Mock).mock.calls[0][2].env.CODEX_HOME;
  await mkdir(join(oldHome, 'sessions')); await writeFile(join(oldHome, 'sessions', 'transcript.jsonl'), '{}');
  notify('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  await new Promise<void>(resolve => { const check = () => events.some(e => e.type === 'result') ? resolve() : setImmediate(check); check(); });
  await adapter.stop(); rpc = []; adapter = new CodexProcess(options); await launch();
  const [, args, settings] = (spawn as jest.Mock).mock.calls[1];
  expect(rpc.find(r => r.method === 'thread/resume')?.params.threadId).toBe(thread); expect(JSON.stringify(rpc)).not.toContain('--last');
  expect(settings.env.CODEX_HOME).not.toBe(oldHome);
  expect(await readFile(join(settings.env.CODEX_HOME, 'sessions', 'transcript.jsonl'), 'utf8')).toBe('{}');
});
test('preserves provider and startup errors', async () => {
  await launch(); notify('error', { error: { message: 'HTTP 429: quota exceeded' } }); child.emit('close', 1, null); await tick();
  expect(events).toContainEqual(expect.objectContaining({ type: 'result', is_error: true, result: 'HTTP 429: quota exceeded' }));
});
test('cancellation while preparing prevents spawn and confirms no process remains', async () => {
  const pending = adapter.start(); await adapter.stop(); await expect(pending).rejects.toThrow(/cancelled/);
  adapter.sendMessage('never execute'); await tick(); expect(spawn).not.toHaveBeenCalled(); expect(adapter.managedGroupStopped).toBe(true);
});
test('fails closed on invalid container binding and missing independent credential', async () => {
  options.agent.type = 'app-agent'; await expect(adapter.start()).rejects.toThrow(); expect(spawn).not.toHaveBeenCalled();
  options.agent.type = undefined as any; delete process.env.TEST_CODEX_KEY; adapter = new CodexProcess(options); await expect(adapter.start()).rejects.toThrow(/credential/);
});
test('bounded stdout fails and stops process group', async () => {
  await launch(); child.stdout.write('x'.repeat(4 * 1024 * 1024 + 1)); await tick();
  expect(events).toContainEqual(expect.objectContaining({ is_error: true, result: expect.stringContaining('bounded') })); expect(stopProcessGroup).toHaveBeenCalledWith(54321);
});

test('steers pending revisions at tool boundaries and acknowledges only accepted input', async () => {
  const acknowledge = jest.fn();
  options.checkpoint = jest.fn().mockResolvedValueOnce({ text: 'new requirement', acknowledge }).mockResolvedValue(undefined);
  await launch(); await tick();
  item({ id: 'cmd', type: 'commandExecution', command: 'true', status: 'completed', exitCode: 0 });
  await waitUntil(() => acknowledge.mock.calls.length === 1);
  expect(rpc.find(r => r.method === 'turn/steer')).toMatchObject({ params: { threadId: thread, expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'new requirement' }] } });
});
test('terminal amendments start another turn before reporting completion', async () => {
  const acknowledge = jest.fn();
  options.checkpoint = jest.fn().mockResolvedValueOnce({ text: 'finish this too', acknowledge }).mockResolvedValue(undefined);
  await launch(); notify('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  await waitUntil(() => acknowledge.mock.calls.length === 1);
  expect(rpc.filter(r => r.method === 'turn/start')).toHaveLength(2); expect(events.some(e => e.type === 'result')).toBe(false);
  item({ id: 'final2', type: 'agentMessage', text: 'All done.' });
  notify('turn/completed', { turn: { id: 'turn-2', status: 'completed' } });
  await waitUntil(() => events.some(e => e.type === 'result'));
  expect(events.filter(e => e.type === 'result')).toEqual([expect.objectContaining({ result: 'All done.' })]);
});

test('container workers use private in-container home, bridge, supervisor and external sandbox', async () => {
  options.agent.type = 'app-agent'; options.agent.container = 'worker-container'; options.profile.containerExecution = true;
  (prepareContainerProfile as jest.Mock).mockResolvedValue({ directory: '/tmp/gateway-orch-1234', config: '/tmp/gateway-orch-1234/mcp.json' });
  (containerNode as jest.Mock).mockImplementation(async (_container, script, args) => script.includes('homedir') ? '/home/worker' : args?.[0]?.endsWith('mcp.json') ? JSON.stringify({ mcpServers: { gateway: { command: 'node', args: ['container-bridge.js'] } } }) : '');
  await launch(); await tick();
  const [bin, args, settings] = (spawn as jest.Mock).mock.calls[0];
  expect(bin).toBe('docker'); expect(args).toContain('worker-container'); expect(args).toContain('app-server');
  expect(settings.env.CODEX_HOME.startsWith(homedir() + '/.gateway-codex-')).toBe(true); expect(args).toContain(`HOME=${homedir()}`);
  expect(JSON.stringify(args)).not.toContain('api-secret');
  expect(rpc.find(r => r.method === 'turn/start').params.sandboxPolicy).toEqual({ type: 'externalSandbox', networkAccess: 'enabled' });
  await adapter.stop(); expect(stopContainerProfile).toHaveBeenCalledWith('worker-container', '/tmp/gateway-orch-1234');
});
test('container preparation failure never falls back to a host process', async () => {
  options.agent.type = 'app-agent'; options.agent.container = 'worker-container';
  (prepareContainerProfile as jest.Mock).mockRejectedValue(new Error('container offline'));
  await expect(adapter.start()).rejects.toThrow('container offline'); expect(spawn).not.toHaveBeenCalled();
});
test('advice at terminal is acknowledged without a new inference turn', async () => {
  const acknowledge = jest.fn(); options.checkpoint = jest.fn().mockResolvedValue({ text: 'verify status', kind: 'advice', acknowledge });
  await launch(); notify('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  await waitUntil(() => events.some(e => e.type === 'result'));
  expect(acknowledge).toHaveBeenCalledTimes(1); expect(rpc.filter(r => r.method === 'turn/start')).toHaveLength(1);
});
test('cancellation during initialization rejects outstanding RPC and stops the group', async () => {
  child.stdin.removeAllListeners('data');
  await adapter.start(); adapter.sendMessage('cancel me'); await tick();
  await adapter.stop(); expect(stopProcessGroup).toHaveBeenCalledWith(54321); expect(adapter.managedGroupStopped).toBe(true);
});
test('a rejected steer racing completion retains the revision for a follow-up turn', async () => {
  const acknowledge = jest.fn(); options.checkpoint = jest.fn().mockResolvedValueOnce({ text: 'amendment', acknowledge }).mockResolvedValue(undefined);
  await launch(); await tick();
  const autoReply = child.stdin.listeners('data')[0]; child.stdin.removeAllListeners('data');
  child.stdin.on('data', (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString());
    if (request.method !== 'turn/steer') { autoReply(chunk); return; }
    rpc.push(request);
    notify('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    emit({ id: request.id, error: { message: 'turn already completed' } });
  });
  item({ id: 'cmd', type: 'commandExecution', command: 'true', status: 'completed', exitCode: 0 });
  await waitUntil(() => acknowledge.mock.calls.length === 1);
  expect(rpc.filter(r => r.method === 'turn/start')).toHaveLength(2); expect(events.some(e => e.type === 'result')).toBe(false);
});

test('credential rotation does not resume a thread from the previous principal', async () => {
  await launch(); await waitUntil(() => rpc.some(r => r.method === 'turn/start')); await adapter.stop();
  process.env.TEST_CODEX_KEY = 'different-principal'; adapter = new CodexProcess(options);
  await expect(adapter.start()).rejects.toThrow('Invalid persisted Codex thread binding');
});
test('rejects an active project configuration layer before starting a thread', async () => {
  const autoReply = child.stdin.listeners('data')[0]; child.stdin.removeAllListeners('data');
  child.stdin.on('data', (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString());
    if(request.method !== 'config/read') return autoReply(chunk);
    rpc.push(request);setImmediate(() => emit({ id: request.id, result: { config: {}, layers: [{ name: { type: 'project' } }] } }));
  });
  const errors: Error[] = []; adapter.on('startup-error', error => errors.push(error));
  await adapter.start(); adapter.sendMessage('never execute');await waitUntil(() => errors.length > 0);
  expect(errors[0].message).toContain('project executable configuration');expect(rpc.some(r => r.method === 'thread/start')).toBe(false);
});

async function sessionDirectory(): Promise<string> {
  const names = await readdir(join(directory, 'codex'));
  return join(directory, 'codex', names[0]);
}
test('failed preparation removes its unpersisted home without requiring stop', async () => {
  await writeFile(options.profile.mcpConfigPath, '{invalid');
  await expect(adapter.start()).rejects.toThrow();
  const root = await sessionDirectory();
  expect((await readdir(root)).filter(name => name.startsWith('attempt-') || name === '.active')).toEqual([]);
  await expect(cleanupCodexSessions({agent: options.agent, stateDirectory: directory, retainedSessionIds: []})).resolves.toBe(1);
});
test('cleanup preserves active leases and warm transcripts, then reclaims expired sessions', async () => {
  await launch();const home = (spawn as jest.Mock).mock.calls[0][2].env.CODEX_HOME;
  const root = await sessionDirectory();
  await expect(cleanupCodexSessions({agent: options.agent, stateDirectory: directory, retainedSessionIds: []})).resolves.toBe(0);
  await expect(access(home)).resolves.toBeUndefined();
  await adapter.stop();
  await expect(cleanupCodexSessions({agent: options.agent, stateDirectory: directory, retainedSessionIds: [options.sessionId]})).resolves.toBe(0);
  await expect(access(join(root, 'thread.json'))).resolves.toBeUndefined();
  await expect(cleanupCodexSessions({agent: options.agent, stateDirectory: directory, retainedSessionIds: []})).resolves.toBe(1);
  await expect(access(home)).rejects.toMatchObject({code:'ENOENT'});
});
test('cleanup retains uncertain processes even if their logical slot is absent', async () => {
  await launch();(stopProcessGroup as jest.Mock).mockResolvedValueOnce(false);
  await adapter.stop();
  expect(adapter.managedGroupStopped).toBe(false);
  await expect(cleanupCodexSessions({agent: options.agent, stateDirectory: directory, retainedSessionIds: []})).resolves.toBe(0);
  await expect(access(join(await sessionDirectory(), '.active'))).resolves.toBeUndefined();
});
test('cleanup is bounded and rotates past protected sessions', async () => {
  const {createHash} = await import('crypto');
  const names: string[] = [];
  for (let index=0;index<5;index++) {
    const sessionId='idle-'+index, root=join(directory,'codex',createHash('sha256').update(directory+'\0'+sessionId).digest('hex'));
    names.push(root);await mkdir(root,{recursive:true});await writeFile(join(root,'homes.json'),JSON.stringify({sessionId,workspace:directory,homes:[]}));
  }
  let removed=0;
  for(let index=0;index<10;index++) {const count=await cleanupCodexSessions({agent:options.agent,stateDirectory:directory,retainedSessionIds:['idle-0'],limit:1});expect(count).toBeLessThanOrEqual(1);removed+=count;}
  expect(removed).toBe(4);await expect(access(names[0])).resolves.toBeUndefined();
});
test('cleanup rejects forged container homes and retries offline containers without host fallback', async () => {
  options.agent.type='app-agent';options.agent.container='worker-container';
  const {createHash}=await import('crypto');const root=join(directory,'codex',createHash('sha256').update(directory+'\0'+options.sessionId).digest('hex'));
  await mkdir(root,{recursive:true});const file=join(root,'homes.json');
  await writeFile(file,JSON.stringify({sessionId:options.sessionId,workspace:directory,container:'worker-container',homes:['/etc']}));
  await expect(cleanupCodexSessions({agent:options.agent,stateDirectory:directory,retainedSessionIds:[]})).resolves.toBe(0);
  expect(containerNode).not.toHaveBeenCalled();
  const home=homedir()+'/.gateway-codex-'+thread;await writeFile(file,JSON.stringify({sessionId:options.sessionId,workspace:directory,container:'worker-container',homes:[home]}));
  (containerNode as jest.Mock).mockRejectedValueOnce(new Error('offline'));
  await expect(cleanupCodexSessions({agent:options.agent,stateDirectory:directory,retainedSessionIds:[]})).resolves.toBe(0);
  await expect(access(file)).resolves.toBeUndefined();await expect(access(join(root,'.active'))).rejects.toMatchObject({code:'ENOENT'});
  (containerNode as jest.Mock).mockResolvedValueOnce('');
  await expect(cleanupCodexSessions({agent:options.agent,stateDirectory:directory,retainedSessionIds:[]})).resolves.toBe(1);
  expect(containerNode).toHaveBeenLastCalledWith('worker-container',expect.any(String),[home]);
});
