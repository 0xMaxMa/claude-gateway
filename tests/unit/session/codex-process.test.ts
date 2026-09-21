import { codexContextPolicy } from '../../../src/session/codex-context';
import { workerEnvironment } from '../../../src/session/worker-environment';
import * as codexAuth from '../../../src/session/codex-auth';
jest.mock('../../../src/session/worker-extensions', () => ({ discoverWorkerExtensions: jest.fn().mockResolvedValue({ skills: [], servers: {}, notices: [] }) }));
import { resolveCodexRuntime } from '../../../src/session/codex-runtime';
import { inspectSelectedCodexRuntime } from '../../../src/session/codex-container-runtime';
jest.mock('../../../src/session/codex-runtime', () => ({ resolveCodexRuntime: jest.fn() }));
jest.mock('../../../src/session/codex-container-runtime', () => ({ inspectSelectedCodexRuntime: jest.fn(), CODEX_RUNTIME_MAINTENANCE: 'refresh-runtime' }));
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
let chatgptMode = false;
function emit(event: any) { child.stdout.write(JSON.stringify(event) + '\n'); }
function notify(method: string, params: any) { emit({ method, params: { threadId: thread, ...params } }); }
function item(value: any, completed = true) { notify(completed ? 'item/completed' : 'item/started', { turnId: 'turn-1', item: value }); }
async function waitUntil(predicate: () => boolean) { const deadline = Date.now() + 2000; while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)); } throw new Error('Condition was not reached'); }

async function launch() { await adapter.start(); adapter.sendMessage('do the task'); await waitUntil(() => rpc.some(r => r.method === 'turn/start')); }
beforeEach(async () => {
  jest.clearAllMocks();
  chatgptMode = false;
  (resolveCodexRuntime as jest.Mock).mockReset().mockImplementation(bin => ({ executable: bin ?? 'codex', containerExecutable: '/opt/gateway-codex/bin/codex', nativeSha256: 'fixture-sha' }));
  (inspectSelectedCodexRuntime as jest.Mock).mockReset().mockResolvedValue('container-one');
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
      const result = request.method === 'config/read' ? { layers: [], config: { shell_environment_policy:{set:workerEnvironment(options.agent, options.gateway)}, model_context_window:codexContextPolicy(options.config.model,options.config.contextWindow).configured, model_provider: chatgptMode ? 'openai' : 'gateway', cli_auth_credentials_store: chatgptMode ? 'ephemeral' : 'file', model_providers: { gateway: { base_url: options.config.baseUrl, env_key: "GATEWAY_CODEX_API_KEY", wire_api: 'responses' } }, mcp_servers: options.agent.type === 'app-agent' ? { gateway: { command: 'node', args: ['container-bridge.js'] } } : { gateway: { command: 'node', args: ['bridge.js'], env: { TICKET: 'secret-ticket' } } } } } : request.method === 'thread/start' || request.method === 'thread/resume' ? { thread: { id: thread } } : request.method === 'turn/start' ? { turn: { id: 'turn-' + (++turnNumber) } } : {};
      setImmediate(() => { emit({ id: request.id, result }); if (request.method === 'turn/start') notify('turn/started', result); });
    }
  });
  (spawn as jest.Mock).mockReturnValue(child);
  adapter = new CodexProcess(options); events = []; adapter.on('output', line => events.push(JSON.parse(line)));
});
afterEach(async () => { await adapter.stop(); jest.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); delete process.env.TEST_CODEX_KEY; });
test('uses private Responses configuration, MCP ticket env and sandbox without credential argv', async () => {
  await launch();
  const [bin, args, settings] = (spawn as jest.Mock).mock.calls[0];
  expect(bin).toBe('codex'); expect(args.slice(-3)).toEqual(['app-server', '--listen', 'stdio://']);
  expect(args).toEqual(expect.arrayContaining(['notify=[]', 'features.hooks=false', 'features.plugins=false', 'features.apps=false', 'features.multi_agent=false']));
  expect(JSON.stringify(args)).not.toMatch(/secret/);
  const config = await readFile(join(settings.env.CODEX_HOME, 'config.toml'), 'utf8');
  expect(config).toContain('sandbox_mode = "workspace-write"');
  expect(config).toContain('env_key = "GATEWAY_CODEX_API_KEY"'); expect(config).not.toContain('api-secret');
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

test('native user questions enter the existing task question flow without inventing an answer', async () => {
  options.requestInput = jest.fn();
  await launch();
  emit({ id: 'question-1', method: 'item/tool/requestUserInput', params: { threadId: thread, questions: [{ id: 'target', question: 'Which target should I use?', options: [{ label: 'Development', description: 'Use the development environment' }] }] } });
  expect(options.requestInput).toHaveBeenCalledWith('Which target should I use?\nDevelopment: Use the development environment');
  expect(events).toContainEqual({ type: 'result', is_error: false, result: 'Waiting for user input.' });
  expect(rpc).toContainEqual({ id: 'question-1', result: { answers: {} } });
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
  options.agent.type = undefined as any; delete process.env.TEST_CODEX_KEY; adapter = new CodexProcess(options); await expect(adapter.start()).rejects.toThrow(/native API key/);
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
  (containerNode as jest.Mock).mockImplementation(async (_container, script, args) => script.includes('createHash') ? 'fixture-sha' : script.includes('homedir') ? '/home/worker' : args?.[0]?.endsWith('mcp.json') ? JSON.stringify({ mcpServers: { gateway: { command: 'node', args: ['container-bridge.js'] } } }) : '');
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

test.each([undefined, 0, 20])('preserves cache-write presence (%s) and partitions inclusive input usage', async cacheWriteInputTokens => {
  await launch();
  const total = { inputTokens: 100, cachedInputTokens: 40, outputTokens: 15, reasoningOutputTokens: 5, ...(cacheWriteInputTokens === undefined ? {} : {cacheWriteInputTokens}) };
  notify('thread/tokenUsage/updated', {turnId:'turn-1',tokenUsage:{total}});
  notify('turn/completed', {turn:{id:'turn-1',status:'completed'}});
  await waitUntil(() => events.some(event => event.type === 'result'));
  const live = events.find(event => event.subtype === 'native_usage').usage;
  const final = events.find(event => event.type === 'result').usage;
  expect(final).toEqual(live);
  expect(final.input_tokens).toBe(60 - (cacheWriteInputTokens ?? 0));
  if (cacheWriteInputTokens === undefined) expect(final).not.toHaveProperty('cache_creation_input_tokens');
  else expect(final).toHaveProperty('cache_creation_input_tokens', cacheWriteInputTokens);
  const collector = new TurnUsageCollector();events.forEach(event => collector.observe(event));
  expect(collector.snapshot().usage).toMatchObject({inputTokens:60-(cacheWriteInputTokens??0),cacheReadTokens:40,cacheCreationTokens:cacheWriteInputTokens??0,outputTokens:15,totalTokens:115});
});

test('persists cumulative cache writes and accounts only the resumed attempt delta', async () => {
  await launch();
  const oldHome = (spawn as jest.Mock).mock.calls[0][2].env.CODEX_HOME;
  await mkdir(join(oldHome,'sessions'));await writeFile(join(oldHome,'sessions','transcript.jsonl'),'{}');
  notify('thread/tokenUsage/updated',{turnId:'turn-1',tokenUsage:{total:{inputTokens:100,cachedInputTokens:40,cacheWriteInputTokens:20,outputTokens:10}}});
  notify('turn/completed',{turn:{id:'turn-1',status:'completed'}});
  await waitUntil(() => events.some(event => event.type === 'result'));await adapter.stop();
  const saved=JSON.parse(await readFile(join(await sessionDirectory(),'thread.json'),'utf8'));
  expect(saved.usage.cacheWriteInputTokens).toBe(20);
  rpc=[];events=[];adapter=new CodexProcess(options);adapter.on('output',line=>events.push(JSON.parse(line)));await launch();
  notify('thread/tokenUsage/updated',{turnId:'turn-2',tokenUsage:{total:{inputTokens:180,cachedInputTokens:70,cacheWriteInputTokens:45,outputTokens:25}}});
  notify('turn/completed',{turn:{id:'turn-2',status:'completed'}});
  await waitUntil(() => events.some(event => event.type === 'result'));
  expect(events.find(event => event.type === 'result').usage).toEqual({input_tokens:25,cache_read_input_tokens:30,cache_creation_input_tokens:25,output_tokens:15});
  const collector=new TurnUsageCollector();events.forEach(event=>collector.observe(event));
  expect(collector.snapshot().usage?.totalTokens).toBe(95);
});

test.each([undefined, 0])('resumed cache writes preserve an unknown versus zero baseline (%s)', async previousWrites => {
  await launch();
  const home=(spawn as jest.Mock).mock.calls[0][2].env.CODEX_HOME;
  await mkdir(join(home,'sessions'));await writeFile(join(home,'sessions','transcript.jsonl'),'{}');
  notify('thread/tokenUsage/updated',{turnId:'turn-1',tokenUsage:{total:{inputTokens:100,cachedInputTokens:40,outputTokens:10,...(previousWrites===undefined?{}:{cacheWriteInputTokens:previousWrites})}}});
  notify('turn/completed',{turn:{id:'turn-1',status:'completed'}});
  await waitUntil(()=>events.some(event=>event.type==='result'));await adapter.stop();
  rpc=[];events=[];adapter=new CodexProcess(options);adapter.on('output',line=>events.push(JSON.parse(line)));await launch();
  notify('thread/tokenUsage/updated',{turnId:'turn-2',tokenUsage:{total:{inputTokens:180,cachedInputTokens:70,cacheWriteInputTokens:20,outputTokens:25}}});
  notify('turn/completed',{turn:{id:'turn-2',status:'completed'}});
  await waitUntil(()=>events.some(event=>event.type==='result'));
  const final=events.find(event=>event.type==='result').usage;
  if(previousWrites===undefined) {
    expect(final).not.toHaveProperty('cache_creation_input_tokens');
    expect(final.input_tokens).toBe(50);
  } else expect(final).toMatchObject({input_tokens:30,cache_creation_input_tokens:20});
  const collector=new TurnUsageCollector();events.forEach(event=>collector.observe(event));
  expect(collector.snapshot().usage?.totalTokens).toBe(95);
});

test.each([true, false])('Codex receives enabled custom connectors only in host execution (%s)', async host => {
  options.profile.hostExecution = host;
  options.gateway = { gateway: { customConnectors: {
    'fixture-remote': { label: 'Fixture', config: { type: 'http', url: 'https://fixture.invalid/mcp', headers: { Authorization: 'Bearer fixture-only' } }, secretNames: [], credentialOwner: 'static' },
    disabled: { label: 'Disabled', config: { command: 'unapproved', args: [] }, secretNames: [], credentialOwner: 'none' },
  } } } as any;
  options.agent.connectors = { disabled: { enabled: false } };
  await adapter.start();
  const root = await sessionDirectory();
  const home = (await readdir(root)).find(name => name.startsWith('attempt-'))!;
  const config = await readFile(join(root, home, 'config.toml'), 'utf8');
  const file = join(directory, 'connector-0.json');
  if (host) {
    expect(config).toContain('[mcp_servers."fixture-remote"]');
    expect(config).toContain('lazy-connector.ts');
    expect(config).not.toContain('fixture-only');
    expect(JSON.parse(await readFile(file, 'utf8')).url).toBe('https://fixture.invalid/mcp');
    expect((await (await import('fs/promises')).stat(file)).mode & 0o777).toBe(0o600);
  } else await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(config).not.toContain('[mcp_servers."disabled"]');
  await adapter.stop();
  await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('failed Codex preparation removes already written connector secrets', async () => {
  options.profile.hostExecution = true;
  options.gateway = { gateway: { customConnectors: { fixture: {
    label: 'Fixture', config: { command: 'node', args: ['fixture.js'] }, secretNames: [], credentialOwner: 'none',
  } } } } as any;
  // The approved gateway server is invalid; connector preparation precedes validation.
  await writeFile(options.profile.mcpConfigPath, JSON.stringify({mcpServers:{gateway:{command:'node',args:[42]}}}));
  await expect(adapter.start()).rejects.toThrow('Codex MCP requires');
  await expect(access(join(directory,'connector-0.json'))).rejects.toMatchObject({code:'ENOENT'});
});

test('missing configured Codex refuses startup without host or harness fallback', async () => {
  options.config.bin = '/missing/codex';
  (resolveCodexRuntime as jest.Mock).mockImplementation(() => { throw new Error('Codex executable missing; install Codex'); });
  await expect(adapter.start()).rejects.toThrow('install Codex');
  expect(resolveCodexRuntime).toHaveBeenCalledWith('/missing/codex', options.agent.workspace);
  expect(spawn).not.toHaveBeenCalled();
});
test('stale app runtime refuses before allocating a container profile or spawning', async () => {
  options.agent.type = 'app-agent'; options.agent.container = 'worker-container';
  (inspectSelectedCodexRuntime as jest.Mock).mockImplementation(() => { throw new Error('CODEX_CONTAINER_RUNTIME_STALE: refresh-runtime'); });
  await expect(adapter.start()).rejects.toThrow('refresh-runtime');
  expect(prepareContainerProfile).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});
test('detects a stale Docker file inode even when mount labels match', async () => {
  options.agent.type = 'app-agent'; options.agent.container = 'worker-container';
  (prepareContainerProfile as jest.Mock).mockResolvedValue({ directory: '/tmp/gateway-orch-1234', config: '/tmp/gateway-orch-1234/mcp.json' });
  (containerNode as jest.Mock).mockResolvedValue('old-binary-sha');
  await expect(adapter.start()).rejects.toThrow('CODEX_CONTAINER_RUNTIME_STALE');
  expect(spawn).not.toHaveBeenCalled();
});

function mockContainerSession(transcript = 'yes') {
  options.agent.type = 'app-agent'; options.agent.container = 'worker-container';
  (prepareContainerProfile as jest.Mock).mockResolvedValue({ directory: '/tmp/gateway-orch-1234', config: '/tmp/gateway-orch-1234/mcp.json' });
  (containerNode as jest.Mock).mockImplementation(async (_container, script, args) => script.includes('createHash') ? 'fixture-sha' : script.includes("isDirectory()?'yes'") ? transcript : args?.[0]?.endsWith('mcp.json') ? JSON.stringify({ mcpServers: { gateway: { command: 'node', args: ['container-bridge.js'] } } }) : '');
}

test.each(['same', 'recreated', 'legacy-present', 'legacy-missing'])('container resume handles %s identity without reading vanished transcript', async kind => {
  mockContainerSession();
  await launch(); await adapter.stop();
  const mapping = join(await sessionDirectory(), 'thread.json');
  const previous = JSON.parse(await readFile(mapping, 'utf8'));
  expect(previous.containerId).toBe('container-one');
  if (kind.startsWith('legacy')) {
    delete previous.containerId;
    await writeFile(mapping, JSON.stringify(previous));
  }
  if (kind === 'recreated') (inspectSelectedCodexRuntime as jest.Mock).mockResolvedValue('container-two');
  mockContainerSession(kind === 'legacy-missing' ? 'no' : 'yes');
  rpc = []; events = []; (containerNode as jest.Mock).mockClear();
  adapter = new CodexProcess(options); adapter.on('output', line => events.push(JSON.parse(line)));
  await launch();
  const resumed = kind === 'same' || kind === 'legacy-present';
  expect(rpc.some(r => r.method === 'thread/resume')).toBe(resumed);
  expect(rpc.some(r => r.method === 'thread/start')).toBe(!resumed);
  const createHome = (containerNode as jest.Mock).mock.calls.find(c => c[1].includes('fs.cpSync'));
  expect(JSON.parse(createHome![3]).previous).toBe(resumed ? previous.home : undefined);
  expect(events.some(e => e.subtype === 'native_session_reset')).toBe(!resumed);
  const saved = JSON.parse(await readFile(mapping, 'utf8'));
  expect(saved.containerId).toBe(kind === 'recreated' ? 'container-two' : 'container-one');
});


test('native credential probe uses the resolved executable for a relative worker bin', async () => {
  const absoluteBin = join(directory, 'bin', 'codex');
  (resolveCodexRuntime as jest.Mock).mockReturnValue({ executable: absoluteBin });
  options.config = { model: 'gpt-test', bin: './bin/codex' };
  const probe: any = new EventEmitter();
  probe.stdin = new PassThrough(); probe.stdout = new PassThrough(); probe.stderr = new PassThrough();
  probe.kill = jest.fn(); probe.unref = jest.fn();
  probe.stdin.on('data', (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString());
    if (request.id === undefined) return;
    const result = request.method === 'config/read' ? { config: { model_provider: 'fixture', model_providers: { fixture: { base_url: 'https://responses.example/v1', env_key: 'TEST_CODEX_KEY' } } } } : { account: null };
    setImmediate(() => probe.stdout.write(JSON.stringify({ id: request.id, result }) + '\n'));
  });
  (spawn as jest.Mock).mockReturnValueOnce(probe);
  await adapter.start();
  expect(resolveCodexRuntime).toHaveBeenCalledWith('./bin/codex', directory);
  expect((spawn as jest.Mock).mock.calls[0][0]).toBe(absoluteBin);
  adapter.sendMessage('run fixture');
  await waitUntil(() => (spawn as jest.Mock).mock.calls.length === 2);
  expect((spawn as jest.Mock).mock.calls[1][0]).toBe(absoluteBin);
});


test.each(['notify', 'hooks', 'apps', 'plugins', 'browser_use', 'computer_use', 'multi_agent', 'image_generation', 'skill_mcp_dependency_install', 'workspace_dependencies', 'web_search'])('rejects unexpected native capability %s before starting a thread', async capability => {
  const autoReply = child.stdin.listeners('data')[0]; child.stdin.removeAllListeners('data');
  child.stdin.on('data', (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString());
    if (request.method !== 'config/read') return autoReply(chunk);
    const config: any = { model_provider: 'gateway', model_providers: { gateway: { base_url: options.config.baseUrl, env_key: 'GATEWAY_CODEX_API_KEY', wire_api: 'responses' } }, mcp_servers: { gateway: { command: 'node', args: ['bridge.js'], env: { TICKET: 'secret-ticket' } } } };
    if (capability === 'notify') config.notify = ['unexpected-program'];
    else if (capability === 'hooks') config.hooks = { SessionStart: [{}] };
    else if (capability === 'web_search') config.web_search = 'live';
    else config.features = { [capability]: true };
    setImmediate(() => emit({ id: request.id, result: { config, layers: [] } }));
  });
  const errors: Error[] = []; adapter.on('startup-error', error => errors.push(error));
  await adapter.start(); adapter.sendMessage('never execute');
  await waitUntil(() => errors.length > 0);
  expect(errors[0].message).toMatch(/not permitted|exceed/);
  expect(rpc.some(r => r.method === 'thread/start')).toBe(false);
});

test.each(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/call'])('never grants unexpected native request %s', async method => {
  await launch();
  emit({ id: 'unapproved-request', method, params: { threadId: thread } });
  await waitUntil(() => events.some(event => event.type === 'result'));
  expect(rpc).toContainEqual({ id: 'unapproved-request', error: { code: -32601, message: 'Interactive requests are not supported by gateway workers' } });
  expect(events).toContainEqual(expect.objectContaining({ type: 'result', is_error: true, result: expect.stringContaining('unsupported interaction') }));
  await waitUntil(() => (stopProcessGroup as jest.Mock).mock.calls.length > 0);
  expect(stopProcessGroup).toHaveBeenCalledWith(54321);
});

test.each(['host','container'])('native ChatGPT %s uses access-only RPC and refreshes without mounting auth', async kind => {
  chatgptMode = true;
  const current = {baseUrl:'https://chatgpt.com/backend-api/codex',key:'',fingerprint:'account-one',chatgpt:{accessToken:'access-one',chatgptAccountId:'account-one'}};
  const resolve=jest.spyOn(codexAuth,'resolveCodexCredentials').mockResolvedValue(current);
  if(kind==='container') {
    options.agent={...options.agent,type:'app-agent',container:'fixture'};
    options.profile={...options.profile,containerExecution:true};
    (prepareContainerProfile as jest.Mock).mockResolvedValue({directory:'/tmp/gateway-orch-fixture',config:'/tmp/mcp.json'});
    (containerNode as jest.Mock).mockImplementation(async (_container,script)=>script.includes('createHash')?'fixture-sha':script.includes('process.stdout.write(require')?JSON.stringify({mcpServers:{gateway:{command:'node',args:['container-bridge.js']}}}):'');
    adapter=new CodexProcess(options);adapter.on('output',line=>events.push(JSON.parse(line)));
  }
  await launch();
  const [_,argv,settings]=(spawn as jest.Mock).mock.calls[0];
  expect(JSON.stringify(argv)).not.toContain('access-one');
  expect(settings.env.GATEWAY_CODEX_API_KEY).toBeUndefined();
  expect(rpc.find(r=>r.method==='account/login/start').params).toEqual({type:'chatgptAuthTokens',...current.chatgpt});
  expect(rpc.findIndex(r=>r.method==='account/login/start')).toBeLessThan(rpc.findIndex(r=>r.method==='thread/start'));
  resolve.mockResolvedValue({...current,chatgpt:{...current.chatgpt,accessToken:'access-two'}});
  emit({id:'refresh-1',method:'account/chatgptAuthTokens/refresh',params:{previousAccountId:'account-one'}});
  await waitUntil(()=>rpc.some(r=>r.id==='refresh-1'));
  expect(rpc.find(r=>r.id==='refresh-1').result.accessToken).toBe('access-two');
  expect(resolve).toHaveBeenLastCalledWith(expect.objectContaining({refreshToken:true}));
  expect(JSON.stringify(events)).not.toContain('access-');
});
test('refresh cannot move an existing worker into another native account', async () => {
  chatgptMode=true;
  const resolve=jest.spyOn(codexAuth,'resolveCodexCredentials').mockResolvedValue({baseUrl:'https://chatgpt.com/backend-api/codex',key:'',fingerprint:'one',chatgpt:{accessToken:'one',chatgptAccountId:'one'}});
  await launch();
  resolve.mockResolvedValue({baseUrl:'https://chatgpt.com/backend-api/codex',key:'',fingerprint:'two',chatgpt:{accessToken:'two',chatgptAccountId:'two'}});
  emit({id:'refresh-2',method:'account/chatgptAuthTokens/refresh',params:{previousAccountId:'one'}});
  await waitUntil(()=>events.some(e=>e.type==='result'));
  expect(rpc.find(r=>r.id==='refresh-2').error.code).toBe(-32001);
  expect(events.find(e=>e.type==='result').result).toContain('CODEX_AUTH_REFRESH_FAILED');
});

it('configures the selected 1M window in the actual worker config and validates native readback', async () => {
  options.config.contextWindow = 1000000;
  adapter = new CodexProcess(options);
  await adapter.start(); adapter.sendMessage('test');
  await waitUntil(() => rpc.some(r => r.method === 'turn/start'));
  const settings = jest.mocked(spawn).mock.calls[0][2] as any;
  const config = await readFile(join(settings.env.CODEX_HOME,'config.toml'),'utf8');
  expect(config).toContain('model_context_window = 1000000');
  expect(config).not.toContain('model_auto_compact_token_limit');
  expect(rpc.some(r => r.method === 'config/read')).toBe(true);
});

test('passes explicit command environment to native config and process without putting values in argv', async () => {
  options.profile.hostExecution=true;
  options.gateway={gateway:{workers:{environment:{BASH_ENV:'/explicit/hook',ZDOTDIR:'/explicit/zsh'}}}} as any;
  await launch();
  const [,args,settings]=(spawn as jest.Mock).mock.calls[0];
  expect(settings.env.BASH_ENV).toBe('/explicit/hook');
  expect(settings.env.ZDOTDIR).toBe('/explicit/zsh');
  expect(JSON.stringify(args)).not.toContain('/explicit/hook');
  const config=await readFile(join(settings.env.CODEX_HOME,'config.toml'),'utf8');
  expect(config).toContain('[shell_environment_policy.set]');
  expect(config).toContain('"BASH_ENV" = "/explicit/hook"');
});

 test.each([false, true])('caps Mini and records native usable context separately on container=%s', async container => {
  if (container) {
    options.agent.type = 'app-agent'; options.agent.container = 'fixture';
    (prepareContainerProfile as jest.Mock).mockResolvedValue({ directory:'/tmp/profile',config:'/tmp/profile/mcp.json' });
    (containerNode as jest.Mock).mockImplementation(async (_container: string, code: string) => code.includes('createHash') ? 'fixture-sha' : code.includes('readFileSync') ? JSON.stringify({mcpServers:{gateway:{command:'node',args:['container-bridge.js']}}}) : '');
    options.profile.connectorsAllowed = false;
  }
  options.config.model = 'gpt-5.4-mini'; options.config.contextWindow = 1000000;
  await launch();
  const initial=events.find(e=>e.subtype==='native_init');
  expect(initial.contextWindow).toMatchObject({requested:1000000,configured:400000,observed:null});
  notify('thread/tokenUsage/updated', { tokenUsage: { modelContextWindow:380000, last:{totalTokens:12000}, total:{inputTokens:3000000,cachedInputTokens:1000000,outputTokens:5000} } });
  const collector=new TurnUsageCollector();events.forEach(e=>collector.observe(e));
  expect(collector.snapshot().contextWindow).toMatchObject({observed:380000,used:12000,status:'observed'});
 });

test('does not silently accept a native window exceeding the configured ceiling', async () => {
 options.config.contextWindow=200000;
 await launch();
 notify('thread/tokenUsage/updated',{tokenUsage:{modelContextWindow:950000,last:{totalTokens:100}}});
 expect(events.find(e=>e.type==='result')).toMatchObject({is_error:true,result:expect.stringContaining('CODEX_CONTEXT_WINDOW_MISMATCH')});
});
test('rejects incorrect config readback before any model request', async () => {
 options.config.contextWindow=1000000;
 const autoReply=child.stdin.listeners('data')[0];child.stdin.removeAllListeners('data');
 child.stdin.on('data',(chunk:Buffer)=>{
  const q=JSON.parse(chunk.toString());if(q.method!=='config/read')return autoReply(chunk);
  rpc.push(q);setImmediate(()=>emit({id:q.id,result:{layers:[],config:{model_context_window:200000}}}));
 });
 const errors:Error[]=[];adapter.on('startup-error',e=>errors.push(e));
 await adapter.start();adapter.sendMessage('never execute');await waitUntil(()=>errors.length>0);
 expect(errors[0].message).toContain('context window configuration mismatch');
 expect(rpc.some(r=>r.method==='thread/start')).toBe(false);
});
