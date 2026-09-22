import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { ProviderAdmissionStore, PROVIDER_ADMISSION_DEFAULTS as policy } from '../../../src/orchestration/provider-admission';

jest.mock('../../../src/orchestration/provider-scope', () => ({resolveProviderScope: (_agent: unknown, _gateway: unknown, model?: string) => model ?? 'down'}));

function fixture() {
  const store = new OrchestrationStore(':memory:', 'a');
  const gate = new ProviderAdmissionStore(':memory:');
  for (let i=0;i<3;i++) gate.settle(gate.acquire('down',policy).permit!,{reason:'server'},policy);
  const send = jest.fn(async () => 'ok'), deliver = jest.fn();
  const runtime = Object.assign(Object.create(AgentOrchestrationRuntime.prototype), {
    store, closing:false, config:{providerAdmission:policy,conversation:{notificationPolicy:'next_user_turn',maxActiveSessions:2,maxDecisionDurationMs:600000}},
    agent:{id:'a',workspace:'/fixture',claude:{model:'down'}}, gateway:{gateway:{}},
    questionControls:{initialReviews:()=>[]}, scheduledReports:new Set(), active:new Map(), send,
    deferred:new Map(), inputTools:new Map(), inputStreams:new Map(), providerAdmission:gate,
    decisions:new DecisionService(store,deliver), publishText:jest.fn(), flushHistory:async()=>{}, delivery:{tick:async()=>{}},
  });
  const accept = (session:string, model?:string) => store.acceptInput({
    scope:{agentId:'a',agentSessionId:session,source:'line',accountId:'owner',chatId:session,threadKey:'',principalId:'owner'},
    text:'Saved input', attachmentIds:['attachment:image','attachment:audio'],modality:'voice_note',
    metadata:{repliedMessageId:'original',senderId:'owner'},capabilities:{execute:false,writeMemory:false},model,
  });
  return {store,gate,runtime,send,deliver,accept};
}

test('waiting inputs preserve multimodal envelopes and do not starve a healthy route behind the page limit',async()=>{
  const f=fixture();
  try {
    for(let i=0;i<105;i++) f.accept('waiting-'+i);
    const healthy=f.accept('healthy','independent');
    const before=f.store.all('SELECT id,ingress_json,attachment_refs_json,input_seq FROM conversation_inputs ORDER BY rowid');
    f.runtime.pumpMailbox(); await Promise.resolve();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect((f.send.mock.calls as unknown[][])[0][0]).toMatchObject({acceptedInputId:healthy.inputId});
    expect(f.store.all('SELECT id,ingress_json,attachment_refs_json,input_seq FROM conversation_inputs ORDER BY rowid')).toEqual(before);
    expect(f.store.get("SELECT COUNT(*) n FROM conversation_decisions WHERE kind='user'")!.n).toBe(0);
    const notices=f.deliver.mock.calls.length;
    f.runtime.pumpMailbox(); await Promise.resolve();
    expect(f.deliver).toHaveBeenCalledTimes(notices);
  } finally {f.gate.close();f.store.close();}
});

test('several blocked routes in one conversation acknowledge each episode once',()=>{
  const f=fixture();
  try {
    const receipt=f.accept('one');
    const a={state:'waiting_for_provider',reason:'server',episode:'a',nextRetryAt:1000,requiresConfigurationChange:false};
    const b={...a,episode:'b'};
    for(let i=0;i<5;i++) {
      f.runtime.waitForProvider('task-a',receipt.conversationId,'route-a',a);
      f.runtime.waitForProvider('task-b',receipt.conversationId,'route-b',b);
    }
    expect(f.deliver).toHaveBeenCalledTimes(2);
    expect(f.store.get('SELECT status FROM conversation_inputs WHERE id=?',receipt.inputId)?.status).toBe('accepted');
  } finally {f.gate.close();f.store.close();}
});

test('stop cancels pending outage input durably without starting a model or task',()=>{
  const f=fixture();
  try {
    const receipt=f.accept('one');
    f.runtime.pumpMailbox();
    expect(f.runtime.stopResponse('one')).toBe(true);
    f.runtime.pumpMailbox();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.store.get('SELECT status FROM conversation_inputs WHERE id=?',receipt.inputId)?.status).toBe('handled');
    expect(f.store.all('SELECT * FROM tasks')).toHaveLength(0);
    expect(f.store.get('SELECT entity_id FROM provider_waits WHERE entity_id=?','session:one')).toBeUndefined();
  } finally {f.gate.close();f.store.close();}
});

test('worker or sibling recovery notifies all waiting conversations for that scope only',()=>{
  const f=fixture();
  try {
    const first=f.accept('one'),second=f.accept('two');
    const waiting={state:'waiting_for_provider',reason:'server',episode:'worker-outage',nextRetryAt:1000,requiresConfigurationChange:false};
    f.runtime.waitForProvider('task-a',first.conversationId,'worker-scope',waiting);
    f.runtime.waitForProvider('task-b',second.conversationId,'worker-scope',waiting);
    f.runtime.waitForProvider('session:one',first.conversationId,'other-scope',{...waiting,episode:'other-outage'});
    f.deliver.mockClear();
    f.runtime.providerRecovered('worker-scope');f.runtime.providerRecovered('worker-scope');
    expect(f.deliver).toHaveBeenCalledTimes(2);
    expect(f.store.get('SELECT recovered FROM provider_notices WHERE conversation_id=? AND scope=?',first.conversationId,'other-scope')?.recovered).toBe(0);
    expect(f.store.get('SELECT entity_id FROM provider_waits WHERE entity_id=?','session:one')).toBeDefined();
    expect(f.store.all("SELECT * FROM conversation_events WHERE type='provider.recovered'")).toHaveLength(2);
  }finally{f.gate.close();f.store.close();}
});
