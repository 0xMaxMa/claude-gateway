import { CHAT_CHANNELS } from '../../../src/history/types';
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { SessionStore } from '../../../src/session/store';
import { SessionProcess } from '../../../src/session/process';
import { HistoryDB } from '../../../src/history/db';
import { AgentConfig, GatewayConfig } from '../../../src/types';

test('R01: restart consumes a committed input with its original principal/model; retry does not generate again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestration-recover-'));
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a');
  const agent: AgentConfig = { id: 'a', workspace: join(root, 'a', 'workspace'), description: '', env: '', claude: { model: 'changed', extraFlags: [] }, orchestration: { enabled: true } };
  const gateway = { gateway: { orchestration: true, headless: true, logDir: root, timezone: 'UTC' }, agents: [agent] } as GatewayConfig;
  const input = { scope: { agentId: 'a', source: 'api' as const, accountId: 'key', chatId: 'chat', agentSessionId: 'original', threadKey: '', principalId: 'owner' },
    text: 'Remember the input', ingressKey: 'stable', model: 'original-model', capabilities: { execute: false, writeMemory: false } };
  const initial = new OrchestrationStore(join(root, 'orchestration.db'), 'a');
  initial.acceptInput(input); initial.close(); // simulated crash after durable ACK, before inference
  const createAgentSession = jest.fn(async (_id: string, _profile: unknown, model?: string) => {
    expect(model).toBe('original-model');
    const agentSession = new EventEmitter() as SessionProcess;
    agentSession.start = async () => {};
    agentSession.stop = async () => {};
    agentSession.sendMessage = () => agentSession.emit('output', JSON.stringify({ type: 'result', result: 'Recovered once.' }));
    return agentSession;
  });
  const runtime = await AgentOrchestrationRuntime.open(agent, gateway, root, sessions, history, { createAgentSession, releaseAgentSession: async () => {} }, { start: async () => { throw new Error('No worker expected'); } });
  try {
    const deadline = Date.now() + 3000;
    while (!runtime.store.get("SELECT id FROM conversation_inputs WHERE status='handled'") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const retry = runtime.submitInput(input, input.capabilities);
    await expect(retry.response).resolves.toBe('Recovered once.');
    expect(createAgentSession).toHaveBeenCalledTimes(1);
    expect((await sessions.loadSession('a', 'original')).map(m => m.content)).toEqual(['Remember the input', 'Recovered once.']);
    runtime.drain(); expect(runtime.canReturnToLegacy()).toBe(true);
    runtime.configure({ enabled: true }); expect(runtime.canReturnToLegacy()).toBe(false);
  } finally { await runtime.close(); (history as unknown as { db: { close(): void } }).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true }); }
});

test('global Off can reopen durable orchestration for recovery and re-enable all channels with shared voice defaults', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestration-global-'));
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a');
  const agent: AgentConfig = { id: 'a', workspace: join(root, 'a', 'workspace'), description: '', env: '', claude: { model: 'fixture', extraFlags: [] }, orchestration: { enabled: true, channels: ['api'] } };
  const gateway = { gateway: { orchestration: false, headless: true, logDir: root, timezone: 'UTC' }, agents: [agent] } as GatewayConfig;
  const createAgentSession = jest.fn();
  const runtime = await AgentOrchestrationRuntime.open(agent, gateway, root, sessions, history, { createAgentSession, releaseAgentSession: async () => {} }, { start: async () => { throw new Error('No worker expected'); } });
  try {
    expect(runtime.canReturnToLegacy()).toBe(true);
    expect(createAgentSession).not.toHaveBeenCalled();
    const {applyGatewayOrchestration} = await import('../../../src/orchestration/gateway-config');
    gateway.gateway.orchestration = { enabled: true, voice: { tts: { voiceId: 'shared-voice' } } };
    runtime.configure(applyGatewayOrchestration(agent, gateway).orchestration);
    expect(runtime.canReturnToLegacy()).toBe(false);
    expect(agent.orchestration!.channels).toEqual(['api', ...CHAT_CHANNELS]);
    expect(agent.voice!.tts!.voiceId).toBe('shared-voice');
    gateway.gateway.orchestration = false;
    runtime.configure(applyGatewayOrchestration(agent, gateway).orchestration);
    expect(runtime.canReturnToLegacy()).toBe(true);
  } finally { await runtime.close(); (history as unknown as { db: { close(): void } }).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true }); }
});

test.each([false, true])('a drained database permits legacy headless=%s and flags without spawning managed processes', async headless => {
  const root=mkdtempSync(join(tmpdir(),'orchestration-legacy-return-'));
  const sessions=new SessionStore(root),history=HistoryDB.forAgent(root,'a');
  const agent:AgentConfig={id:'a',workspace:join(root,'a','workspace'),description:'',env:'',claude:{model:'fixture',extraFlags:['--legacy-flag']}};
  const gateway={gateway:{orchestration:false,headless,logDir:root,timezone:'UTC'},agents:[agent]} as GatewayConfig;
  const db=new OrchestrationStore(join(root,'orchestration.db'),'a');db.close();
  const createAgentSession=jest.fn(),start=jest.fn();
  const runtime=await AgentOrchestrationRuntime.open(agent,gateway,root,sessions,history,{createAgentSession,releaseAgentSession:async()=>{}},{start});
  try {
    expect(runtime.canReturnToLegacy()).toBe(true);
    expect(createAgentSession).not.toHaveBeenCalled();expect(start).not.toHaveBeenCalled();
    expect(()=>runtime.configure({enabled:true})).toThrow();
  } finally { await runtime.close();(history as any).db.close();HistoryDB.evict(root,'a');rmSync(root,{recursive:true,force:true}); }
});

test('runner hot reload updates the actual orchestration sender and worker config, including removal', async () => {
  const {AgentRunner}=await import('../../../src/agent/runner');
  const root=mkdtempSync(join(tmpdir(),'orchestration-reload-'));
  const sessions=new SessionStore(root),history=HistoryDB.forAgent(root,'a');
  const agent:AgentConfig={id:'a',workspace:join(root,'a','workspace'),description:'',env:'',claude:{model:'old-model',extraFlags:[]},telegram:{botToken:'old-token'}};
  const gateway={gateway:{orchestration:true,headless:true,logDir:root,timezone:'UTC'},agents:[agent]} as GatewayConfig;
  const request=jest.spyOn(global,'fetch').mockImplementation(async()=>new Response(JSON.stringify({ok:true,result:{message_id:1}}),{status:200}));
  const runtime=await AgentOrchestrationRuntime.open(agent,gateway,root,sessions,history,{createAgentSession:jest.fn(),releaseAgentSession:async()=>{}});
  try {
    const runner=Object.create(AgentRunner.prototype) as any;
    Object.assign(runner,{agentConfig:agent,gatewayConfig:gateway,orchestration:runtime,whatsappAccounts:new Map(),whatsappAccountForChat:new Map()});
    for(const method of ['syncWhatsAppAccounts','stopWhatsAppCloudOutbound','startWhatsAppCloudOutbound','refreshTelegramCommands','stopLineReply','startLineReply','stopSlackOutbound','startSlackOutbound'])runner[method]=()=>{};
    const send=(runtime as any).delivery.send;
    const binding={channel:'telegram',chat_id:'fixture',thread_key:''};
    await expect(send(binding,'old','id')).resolves.toMatchObject({state:'delivered'});
    expect(request.mock.calls.slice(-1)[0][0]).toContain('botold-token/');
    runner.updateAgentConfig({...agent,telegram:{botToken:'new-token'},claude:{...agent.claude,model:'new-model'}});
    await expect(send(binding,'new','id')).resolves.toMatchObject({state:'delivered'});
    expect(request.mock.calls.slice(-1)[0][0]).toContain('botnew-token/');
    expect((runtime as any).scheduler.driver.agent.claude.model).toBe('new-model');
    expect((runtime as any).scheduler.driver.agent.telegram.botToken).toBe('new-token');
    runner.updateAgentConfig({...agent,telegram:undefined});
    request.mockClear();
    await expect(send(binding,'disabled','id')).resolves.toMatchObject({state:'failed',code:'DELIVERY_NOT_CONFIGURED'});
    expect(request).not.toHaveBeenCalled();
    expect(()=>runner.updateAgentConfig({...agent,type:'app-agent',container:'different-boundary'})).toThrow('ORCHESTRATION_IDENTITY_CHANGED');
  } finally {await runtime.close();request.mockRestore();(history as any).db.close();HistoryDB.evict(root,'a');rmSync(root,{recursive:true,force:true});}
});
