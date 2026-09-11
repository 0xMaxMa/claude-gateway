import { OrchestrationStore, Row } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { DeliveryOutbox, channelSender } from '../../../src/orchestration/delivery';
import { ProcessCapacity } from '../../../src/orchestration/capacity';
import { recoverOrchestration } from '../../../src/orchestration/recovery';
import type { AgentConfig } from '../../../src/types';

test('legacy processes present before enable count; workers cannot take the reserved agent session slot', () => {
  const capacity = new ProcessCapacity(3, 1);
  const legacy = capacity.acquire('legacy', false)!;
  const worker = capacity.acquire('worker')!;
  expect(capacity.acquire('worker')).toBeUndefined();
  const agentSession = capacity.acquire('agent')!;
  expect(capacity.count).toBe(3);
  expect(capacity.acquire('agent')).toBeUndefined();
  legacy(); legacy(); worker(); agentSession(); expect(capacity.count).toBe(0);
});

test('channel response/delivery commit together; ambiguous acceptance neither retries nor sends later chunks', async () => {
  const store = new OrchestrationStore(':memory:', 'a');
  const sender = jest.fn(async (_binding: Row, _text: string, _id: string) => ({ state: 'unknown' as const, code: 'TIMEOUT' }));
  const delivery = new DeliveryOutbox(store, sender);
  const decisions = new DecisionService(store, (r, b, text) => delivery.enqueue(r, b, text));
  try {
    const receipt = store.acceptInput({ scope: { agentId: 'a', agentSessionId: 'p', source: 'slack', accountId: 'bot', chatId: 'old-chat', threadKey: 'old-thread', principalId: 'user' }, text: 'hello' });
    const decision = decisions.begin(receipt.conversationId, 'user', [receipt.inputId]);
    decisions.finish(decision, 'x'.repeat(4000));
    expect(store.get("SELECT COUNT(*) n FROM deliveries WHERE state='pending'")!.n).toBe(3);
    await delivery.tick(); await delivery.tick();
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender.mock.calls[0][0]).toMatchObject({ chat_id: 'old-chat', thread_key: 'old-thread' });
    expect(store.get("SELECT COUNT(*) n FROM deliveries WHERE state='unknown'")!.n).toBe(1);
    store.run("UPDATE deliveries SET state='sending' WHERE state='pending'");
    recoverOrchestration(store);
    expect(store.get("SELECT COUNT(*) n FROM deliveries WHERE state='unknown'")!.n).toBe(3);
  } finally { store.close(); }
});

test.each(['telegram', 'discord', 'line', 'slack'] as const)('transport %s binds destination and returns provider acceptance', async source => {
  const request = jest.fn(async () => ({ ok: true, json: async () => ({ ok: true, id: 'receipt' }) }));
  const agent = { telegram: { botToken: 'fixture' }, discord: { botToken: 'fixture' }, line: { channelAccessToken: 'fixture' }, slack: { botToken: 'fixture' } } as AgentConfig;
  const outcome = await channelSender(agent, request as unknown as typeof fetch)({ channel: source, chat_id: '123', thread_key: '456' }, 'hello', '9e998bbb-1ba3-44ab-8a4c-fb6cc3096ead');
  expect(outcome).toEqual({ state: 'delivered', providerId: 'receipt' });
  const body = JSON.parse((request.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
  if (source === 'telegram') expect(body).toMatchObject({ chat_id: '123', message_thread_id: 456 });
  if (source === 'slack') expect(body).toMatchObject({ channel: '123', thread_ts: '456' });
  if (source === 'discord') expect(body).toMatchObject({ enforce_nonce: true, allowed_mentions: { parse: [] } });
  if (source === 'line') expect(body.to).toBe('123');
});

test('Telegram formats a full report before durable chunking and preserves code blocks across receipts', async () => {
  const store = new OrchestrationStore(':memory:', 'a');
  const bodies: any[] = [];
  const request = jest.fn(async (_url: any, options: any) => { bodies.push(JSON.parse(options.body)); return {ok:true,json:async()=>({ok:true,result:{message_id:bodies.length}})}; });
  const agent = {telegram:{botToken:'fixture'}} as AgentConfig;
  const delivery = new DeliveryOutbox(store,channelSender(agent,request as unknown as typeof fetch));
  try {
    const input=store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'telegram',accountId:'bot',principalId:'u',chatId:'123',threadKey:'456'},text:'status'});
    const decisions=new DecisionService(store,(r,b,t)=>delivery.enqueue(r,b,t));
    const decision=decisions.begin(input.conversationId,'u',[input.inputId]);
    decisions.finish(decision,'**Task failed**\n`WORKER_START_FAILED`\n```\n'+('fatal: <repo> & missing .git\n'.repeat(180))+'```\n**Next step**');
    await delivery.tick();
    expect(bodies.length).toBeGreaterThan(2);
    expect(bodies[0].text).toContain('<b>Task failed</b>');
    expect(bodies[0].text).toContain('<code>WORKER_START_FAILED</code>');
    for(const body of bodies){
      expect(body).toMatchObject({parse_mode:'HTML',chat_id:'123',message_thread_id:456});
      expect(body.text.length).toBeLessThanOrEqual(1900);
      expect(body.text).not.toContain('```');
      expect(body.text.match(/<pre>/g)?.length??0).toBe(body.text.match(/<\/pre>/g)?.length??0);
      expect(body.text.match(/<code>/g)?.length??0).toBe(body.text.match(/<\/code>/g)?.length??0);
    }
    expect(bodies.map(b=>b.text).join('')).toContain('&lt;repo&gt; &amp; missing');
    await delivery.tick();
    expect(request).toHaveBeenCalledTimes(bodies.length);
  } finally {store.close();}
});

test.each([400, 500])('Telegram retries plain text only for a definite entity rejection (%i)', async status => {
  const bodies: any[]=[];
  const request=jest.fn(async (_url:any,options:any)=>{
    bodies.push(JSON.parse(options.body));
    return bodies.length===1
      ? new Response(JSON.stringify({ok:false,description:"Bad Request: can't parse entities"}),{status})
      : new Response(JSON.stringify({ok:true,result:{message_id:1}}),{status:200});
  });
  const sender=channelSender({telegram:{botToken:'fixture'}} as AgentConfig,request as unknown as typeof fetch);
  const outcome=await sender({channel:'telegram',chat_id:'123',thread_key:'456'},'**Failed**: `git`','id');
  if(status===400){
    expect(outcome).toMatchObject({state:'delivered'});
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual({chat_id:'123',message_thread_id:456,text:'Failed: git'});
  } else {
    expect(outcome).toMatchObject({state:'unknown'});
    expect(bodies).toHaveLength(1);
  }
});

test.each(['unknown', 'failed'] as const)('a %s response with over 20 blocked chunks does not starve other chats', async state => {
  const store = new OrchestrationStore(':memory:', 'a');
  const sender = jest.fn(async (binding: Row) => binding.chat_id === 'blocked'
    ? { state, code: 'PROVIDER_ERROR' }
    : { state: 'delivered' as const, providerId: 'ok' });
  const delivery = new DeliveryOutbox(store, sender);
  const decisions = new DecisionService(store, (r, b, text) => delivery.enqueue(r, b, text));
  try {
    for (const chat of ['blocked', 'healthy']) {
      const input = store.acceptInput({ scope: { agentId: 'a', agentSessionId: chat, source: 'slack', accountId: 'bot', chatId: chat, threadKey: '', principalId: 'user' }, text: 'hello' });
      decisions.finish(decisions.begin(input.conversationId, 'user', [input.inputId]), chat === 'blocked' ? 'x'.repeat(43000) : 'answer');
    }
    await delivery.tick(); await delivery.tick();
    expect(sender.mock.calls.map(([binding]) => binding.chat_id)).toEqual(['blocked', 'healthy']);
    expect(store.get("SELECT COUNT(*) n FROM deliveries WHERE state='pending'")!.n).toBeGreaterThan(20);
  } finally { store.close(); }
});

test('LINE strips Markdown before chunking, retaining links and paragraphs without changing other channels', async () => {
  const store = new OrchestrationStore(':memory:', 'a');
  const bodies: any[] = [];
  const request = jest.fn(async (_url: any, options: any) => { bodies.push(JSON.parse(options.body)); return new Response(JSON.stringify({sentMessages:[{id:String(bodies.length)}]})); });
  const agent = {id:'a',line:{channelAccessToken:'fixture'}} as AgentConfig;
  const delivery = new DeliveryOutbox(store,channelSender(agent,request));
  try {
    const input=store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'line',accountId:'bot',principalId:'u',chatId:'123',threadKey:''},text:'status'});
    const decisions=new DecisionService(store,(r,b,t)=>delivery.enqueue(r,b,t));
    const decision=decisions.begin(input.conversationId,'u',[input.inputId]);
    const text='**'+ 'งานสำเร็จ '.repeat(400)+'**\n\n- [ดูรายละเอียด](https://example.com/tasks)\n`complete`';
    decisions.finish(decision,text);
    await delivery.tick();
    expect(bodies.length).toBeGreaterThan(1);
    const sent=bodies.map(b=>b.messages[0].text).join('');
    expect(sent).not.toContain('**');expect(sent).not.toContain('`');
    expect(sent).toContain('\n\n• ดูรายละเอียด (https://example.com/tasks)\ncomplete');
    expect(bodies.every(b=>b.messages[0].text.length<=1900)).toBe(true);
    expect(store.get('SELECT generated_text FROM assistant_responses WHERE id=?',decision.responseId!)?.generated_text).toBe(text);
  } finally {store.close();}
});
