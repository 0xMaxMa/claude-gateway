import { resolveCodexRuntime } from '../../../src/session/codex-runtime';
jest.mock('../../../src/orchestration/container', () => ({ ...jest.requireActual('../../../src/orchestration/container'), validateContainer: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../../src/session/codex-container-runtime', () => ({ inspectSelectedCodexRuntime: jest.fn().mockResolvedValue('fixture-container') }));
jest.mock('../../../src/session/codex-runtime', () => ({ resolveCodexRuntime: jest.fn().mockReturnValue({executable:'codex'}) }));
import { resolveCodexCredentials, CodexReadinessError } from '../../../src/session/codex-auth';
jest.mock('../../../src/session/codex-auth', () => ({ ...jest.requireActual('../../../src/session/codex-auth'), resolveCodexCredentials: jest.fn().mockResolvedValue({baseUrl:'https://fixture.invalid/v1',key:'fixture-key',fingerprint:'fixture'}) }));
import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService, SpawnTask } from '../../../src/orchestration/tasks/service';
import { TaskBridge } from '../../../src/orchestration/bridge';
import { TaskWorkspaces } from '../../../src/orchestration/tasks/workspace';
import { ClaudeWorkerDriver } from '../../../src/orchestration/tasks/driver';
import { SessionProcess } from '../../../src/session/process';
import { CodexProcess, cleanupCodexSessions } from '../../../src/session/codex-process';
import { startProcessTurn } from '../../../src/orchestration/process-turn';
import type { AgentConfig, GatewayConfig } from '../../../src/types';
import type { CommandContext } from '../../../src/orchestration/types';

class MockWorker extends EventEmitter {
  managedGroupStopped = true;
  managedProcessId = undefined;
  spawnedAt = Date.now();
  constructor(readonly runtimeProfile: any) { super(); }
  start = jest.fn(async () => {});
  stop = jest.fn(async () => {});
  interrupt = jest.fn(async () => {});
  sendMessage = jest.fn(() => {
    this.emit('output', JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Verified fixture'}]}}));
    this.emit('output', JSON.stringify({type:'result',result:'Verified fixture'}));
  });
}
jest.mock('../../../src/session/process', () => ({ SessionProcess: jest.fn().mockImplementation((...args: any[]) => new MockWorker(args[6])) }));
jest.mock('../../../src/session/codex-process', () => ({ cleanupCodexSessions: jest.fn().mockResolvedValue(0), CodexProcess: jest.fn().mockImplementation((options: any) => new MockWorker(options.profile)) }));

let root: string, store: OrchestrationStore, tasks: TaskService, bridge: TaskBridge;
let agent: AgentConfig, gateway: GatewayConfig, driver: ClaudeWorkerDriver, context: CommandContext, sequence: number;
beforeEach(async () => {
  jest.clearAllMocks(); sequence = 0;
  jest.mocked(resolveCodexCredentials).mockResolvedValue({baseUrl:'https://fixture.invalid/v1',key:'fixture-key',fingerprint:'fixture'});
  root = mkdtempSync(join(tmpdir(),'codex-driver-'));
  writeFileSync(join(root,'CLAUDE.md'),'Agent persona stays Claude.');
  store = new OrchestrationStore(':memory:','a');
  tasks = new TaskService(store,{tasks:{workspaceMode:'host',maxConcurrentPerAgent:10,maxConcurrentPerConversation:10}},root);
  bridge = new TaskBridge(tasks); await bridge.start();
  const input = store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'api',accountId:'u',principalId:'u',chatId:'c',threadKey:''},text:'Implement the authorized fixture'});
  const decision = new DecisionService(store).begin(input.conversationId,'u',[input.inputId]);
  context = {...input,...decision,principalId:'u',execute:true,writeMemory:false,actionId:''};
  agent = {id:'a',workspace:root,claude:{model:'claude-sonnet-4-6'}} as AgentConfig;
  gateway = {gateway:{workers:{harness:'auto'}}} as GatewayConfig;
  driver = new ClaudeWorkerDriver(agent,gateway,tasks,bridge,new TaskWorkspaces(store,root,join(root,'resources'),'host'),join(root,'attempts'));
});
afterEach(async () => {await bridge.close();store.close();rmSync(root,{recursive:true,force:true});});
function spawn(model: string, extra: Partial<SpawnTask> = {}) {
  return tasks.spawn({...context,model,actionId:`spawn-${++sequence}`},{title:'Fixture',instructions:'Implement fixture',targetProfile:'default-worker',...extra});
}
async function run(model: string, extra: Partial<SpawnTask> = {}) {
  const task = spawn(model,extra), attempt = tasks.claim(task.taskId)!;
  const handle = await driver.start(task,attempt);
  await handle.accepted;
  const result = await handle.result;
  expect(result.type).toBe('completed');
  tasks.finish(attempt.attemptId,attempt.generation,result);
  return {task,attempt};
}

test('auto routes GPT workers to Codex and persists native identity without changing the Claude agent configuration', async () => {
  const before = JSON.stringify(agent);
  const {attempt} = await run('openai/gpt-5.6-luna[1m]');
  expect(CodexProcess).toHaveBeenCalledTimes(1);
  expect(SessionProcess).not.toHaveBeenCalled();
  expect(jest.mocked(CodexProcess).mock.calls[0][0]).toMatchObject({config:{model:'openai/gpt-5.6-luna'},profile:{role:'worker',hostExecution:true}});
  expect(store.attempt(attempt.attemptId)).toMatchObject({harness:'codex',harnessModel:'openai/gpt-5.6-luna'});
  expect(JSON.stringify(agent)).toBe(before);
  expect(agent.claude.model).toBe('claude-sonnet-4-6');
});

test('defaults to Codex for GPT when no worker routing is configured', async () => {
  delete gateway.gateway.workers;
  const {attempt} = await run('gpt-5.6-luna[1m]');
  expect(CodexProcess).toHaveBeenCalledTimes(1);
  expect(SessionProcess).not.toHaveBeenCalled();
  expect(store.attempt(attempt.attemptId)).toMatchObject({harness:'codex',harnessModel:'gpt-5.6-luna'});
});

test('explicit model metadata resolves non-GPT aliases to the native provider model', async () => {
  gateway.gateway.models = [{id:'provider-fast',alias:'fast-worker',workerHarness:'codex',workerModel:'gpt-5.6-luna'}] as any;
  const {attempt} = await run('fast-worker');
  expect(jest.mocked(CodexProcess).mock.calls[0][0].config.model).toBe('gpt-5.6-luna');
  expect(store.attempt(attempt.attemptId)).toMatchObject({harness:'codex',harnessModel:'gpt-5.6-luna'});
});

test.each(['harness','provider-config'] as const)('warm continuation resets its session when %s changes', async change => {
  const first = await run('gpt-5.6-luna');
  const next = spawn('gpt-5.6-luna',{continueTaskId:first.task.taskId});
  const attempt = tasks.claim(next.taskId)!;
  expect(attempt).toMatchObject({resumeSession:true,sessionId:first.attempt.sessionId});
  if (change === 'harness') gateway.gateway.workers = {harness:'claude'};
  else gateway.gateway.workers!.codex = {reasoningEffort:'high',baseUrl:'https://responses.example/v1'};
  const handle = await driver.start(next,attempt); await handle.accepted; await handle.result;
  expect(attempt.resumeSession).toBe(false);
  expect(attempt.sessionId).not.toBe(first.attempt.sessionId);
  expect(store.attempt(attempt.attemptId)?.sessionId).toBe(attempt.sessionId);
  if (change === 'harness') expect(SessionProcess).toHaveBeenCalledTimes(1);
  else expect(jest.mocked(CodexProcess).mock.calls[1][0]).toMatchObject({profile:{cliSession:{resume:false}},config:{reasoningEffort:'high'}});
});

test('unchanged native harness resumes the warm continuation session', async () => {
  const first = await run('gpt-5.6-luna');
  const second = await run('gpt-5.6-luna',{continueTaskId:first.task.taskId});
  expect(second.attempt).toMatchObject({resumeSession:true,sessionId:first.attempt.sessionId});
  expect(jest.mocked(CodexProcess).mock.calls[1][0].profile.cliSession?.resume).toBe(true);
});

test('file skill material is pinned and its resources are supplied to the native worker', async () => {
  const source = join(root,'installed-skill'); mkdirSync(source);
  writeFileSync(join(source,'SKILL.md'),'Stale source content');
  writeFileSync(join(source,'reference.txt'),'Supporting evidence');
  await run('gpt-5.6-luna',{targetProfile:'skill-worker',skill:{name:'fixture',args:'check',content:'---\nname: fixture\n---\nUse pinned instructions.',filePath:join(source,'SKILL.md')}});
  const options = jest.mocked(CodexProcess).mock.calls[0][0];
  const copied = join(options.profile.skillPluginDir!,'skills','fixture');
  expect(readFileSync(join(copied,'SKILL.md'),'utf8')).toContain('Use pinned instructions.');
  expect(readFileSync(join(copied,'SKILL.md'),'utf8')).not.toContain('Stale source content');
  expect(readFileSync(join(copied,'reference.txt'),'utf8')).toBe('Supporting evidence');
  const process = jest.mocked(CodexProcess).mock.results[0].value as MockWorker;
  expect(process.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Use pinned instructions.'), []);
  expect(process.sendMessage).not.toHaveBeenCalledWith(expect.stringContaining('invoke that exact name via Skill'), []);
});

test('CLI-only skills fail explicitly without starting Claude as fallback', async () => {
  const task = spawn('gpt-5.6-luna',{targetProfile:'skill-worker',skill:{invocation:'cli',name:'native-only',args:'',content:'',filePath:''}});
  const attempt = tasks.claim(task.taskId)!;
  await expect(driver.start(task,attempt)).rejects.toMatchObject({code:'CODEX_SKILL_UNAVAILABLE'});
  expect(CodexProcess).not.toHaveBeenCalled(); expect(SessionProcess).not.toHaveBeenCalled();
});

test('native startup failure is a task failure and never retries through Claude', async () => {
  jest.mocked(CodexProcess).mockImplementationOnce((options: any) => {
    const process = new MockWorker(options.profile);
    process.start.mockRejectedValueOnce(Object.assign(new Error('Missing native credential'),{code:'CODEX_AUTH_REQUIRED'}));
    return process as any;
  });
  const task = spawn('gpt-5.6-luna'), attempt = tasks.claim(task.taskId)!;
  const handle = await driver.start(task,attempt);
  await expect(handle.accepted).rejects.toMatchObject({code:'CODEX_AUTH_REQUIRED'});
  await expect(handle.result).resolves.toMatchObject({type:'failed'});
  expect(CodexProcess).toHaveBeenCalledTimes(1); expect(SessionProcess).not.toHaveBeenCalled();
});

test('an attempt already bound to another harness is rejected without fallback', async () => {
  const task = spawn('gpt-5.6-luna'), attempt = tasks.claim(task.taskId)!;
  attempt.harness = 'claude';
  store.transaction(() => store.saveAttempt(attempt));
  await expect(driver.start(task,attempt)).rejects.toMatchObject({code:'WORKER_HARNESS_CHANGED'});
  expect(CodexProcess).not.toHaveBeenCalled(); expect(SessionProcess).not.toHaveBeenCalled();
});

test('app workers with a host workspace are rejected before either harness starts', async () => {
  agent.type = 'app-agent'; agent.container = 'fixture-agent';
  const task = spawn('gpt-5.6-luna'), attempt = tasks.claim(task.taskId)!;
  await expect(driver.start(task,attempt)).rejects.toMatchObject({code:'CONTAINER_WORKSPACE_REQUIRED'});
  expect(CodexProcess).not.toHaveBeenCalled(); expect(SessionProcess).not.toHaveBeenCalled();
});

test('native init leaves inventory unknown and cumulative native usage is reconciled without double counting', async () => {
  const process = new MockWorker({role:'worker'});
  process.sendMessage.mockImplementation(() => {
    for (const event of [
      {type:'system',subtype:'native_init',model:'gpt-5.6-luna'},
      {type:'system',subtype:'native_usage',usage:{input_tokens:10,cache_read_input_tokens:20,output_tokens:3}},
      {type:'system',subtype:'native_usage',usage:{input_tokens:15,cache_read_input_tokens:25,output_tokens:5}},
      {type:'assistant',message:{content:[{type:'text',text:'Complete'}]}},
      {type:'result',result:'Complete',usage:{input_tokens:15,cache_read_input_tokens:25,output_tokens:5}},
    ]) process.emit('output',JSON.stringify(event));
  });
  const metrics = jest.fn();
  const turn = startProcessTurn(process as any,'Fixture',1000,undefined,metrics);
  await expect(turn.result).resolves.toMatchObject({text:'Complete',interrupted:false});
  expect(metrics).toHaveBeenCalledTimes(1);
  expect(metrics.mock.calls[0][0]).toMatchObject({model:'gpt-5.6-luna',loadedTools:null,contextTools:null,requests:[],inputTokens:40,totalTokens:45,usage:{inputTokens:15,cacheReadTokens:25,outputTokens:5,totalTokens:45}});
});

test('transcript cleanup retains the newly bound slot and cannot reject an admitted task', async () => {
  jest.mocked(cleanupCodexSessions).mockRejectedValueOnce(new Error('disposable cleanup failed'));
  const { attempt } = await run('gpt-5.6-luna');
  expect(cleanupCodexSessions).toHaveBeenCalledWith(expect.objectContaining({ retainedSessionIds: [attempt.sessionId] }));
  expect(tasks.pool.retainedSessionIds()).toEqual([attempt.sessionId]);
  tasks.pool.prune(0, Date.now() + 1);
  expect(tasks.pool.retainedSessionIds()).toEqual([]);
});

test.each([undefined, 'auto'] as const)('falls back before dispatch without auth (selector=%s)', async selector => {
  gateway.gateway.workers = selector ? {harness:selector} : undefined;
  jest.mocked(resolveCodexCredentials).mockRejectedValueOnce(new CodexReadinessError('CODEX_AUTH_REQUIRED','missing'));
  const {attempt} = await run('gpt-fixture');
  expect(attempt.harness).toBe('claude');
  expect(CodexProcess).not.toHaveBeenCalled();
  expect(SessionProcess).toHaveBeenCalledTimes(1);
});
test('explicit Codex never silently changes the selected harness', async () => {
  gateway.gateway.workers = {harness:'codex'};
  jest.mocked(resolveCodexCredentials).mockRejectedValueOnce(new CodexReadinessError('CODEX_AUTH_REQUIRED','missing'));
  const task=spawn('gpt-fixture'),attempt=tasks.claim(task.taskId)!;
  await expect(driver.start(task,attempt)).rejects.toMatchObject({code:'CODEX_AUTH_REQUIRED'});
  expect(CodexProcess).not.toHaveBeenCalled(); expect(SessionProcess).not.toHaveBeenCalled();
});


test('cancellation during native readiness cannot launch either worker harness', async () => {
  const task = spawn('gpt-fixture'), attempt = tasks.claim(task.taskId)!;
  jest.mocked(resolveCodexCredentials).mockImplementationOnce(async () => {
    tasks.cancel({...context, actionId:'cancel-during-readiness'}, task.taskId);
    return {baseUrl:'https://fixture.invalid/v1',key:'fixture-key',fingerprint:'fixture'};
  });
  await expect(driver.start(task,attempt)).rejects.toMatchObject({code:'ATTEMPT_CANCELLED_BEFORE_START'});
  expect(CodexProcess).not.toHaveBeenCalled(); expect(SessionProcess).not.toHaveBeenCalled();
});


test.each([false, true])('Docker host HTTP auth policy matches worker placement (container=%s)', async container => {
  agent.type = container ? 'app-agent' : 'user' as any;
  gateway.gateway.workers = { harness: 'codex' };
  const task = spawn('gpt-fixture'), attempt = tasks.claim(task.taskId)!;
  if (container) task.resourceProfile = { mode: 'container' } as any;
  const actual = jest.requireActual('../../../src/session/codex-auth').resolveCodexCredentials;
  jest.mocked(resolveCodexCredentials).mockImplementationOnce(async options => {
    // Exercise the real URL policy with a provider discovered from native config.
    const credentials = await actual({ ...options, baseUrl: 'http://host.docker.internal:8090/v1', apiKeyEnv: 'FIXTURE_KEY', env: { FIXTURE_KEY: 'test-only' } });
    // Stop before workspace/container execution: this test exercises admission.
    tasks.cancel({ ...context, actionId: 'cancel-after-provider-check' }, task.taskId);
    return credentials;
  });
  if (container) await expect(driver.start(task, attempt)).rejects.toMatchObject({ code: 'ATTEMPT_CANCELLED_BEFORE_START' });
  else await expect(driver.start(task, attempt)).rejects.toMatchObject({ code: 'CODEX_PROVIDER_INVALID' });
  expect(CodexProcess).not.toHaveBeenCalled();
  expect(SessionProcess).not.toHaveBeenCalled();
});


test('default auto falls back to Claude when Codex is not installed', async () => {
  delete gateway.gateway.workers;
  jest.mocked(resolveCodexRuntime).mockImplementationOnce(() => { throw new Error('Codex executable missing'); });
  const {attempt} = await run('gpt-fixture');
  expect(attempt.harness).toBe('claude');
  expect(CodexProcess).not.toHaveBeenCalled();
  expect(SessionProcess).toHaveBeenCalledTimes(1);
  expect(resolveCodexCredentials).not.toHaveBeenCalled();
});
