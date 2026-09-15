import { channelSender, ChannelSender, DeliveryOutbox } from '../../../src/orchestration/delivery';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import type { AgentConfig } from '../../../src/types';

const controls = [
  {label: 'Remind me later', data: 'orch:q:05e29cb7-26ac-4881-a408-4182ffcb00e7:snooze'},
  {label: 'Mute reminders', data: 'orch:q:05e29cb7-26ac-4881-a408-4182ffcb00e7:mute'},
];
const config = {id: 'a', telegram: {botToken: 'token'}, discord: {botToken: 'token'}, slack: {botToken: 'token'}, line: {channelAccessToken: 'token'}} as AgentConfig;

test.each(['telegram', 'discord', 'slack', 'line'])('%s sends native reminder controls with the complete text and original destination', async channel => {
  const request = jest.fn(async () => new Response(JSON.stringify({ok: true, id: 'receipt'})));
  const text = 'Question?\n' + 'Details '.repeat(200);
  await channelSender(config, request)({channel, chat_id: '123', thread_key: '456'}, text, 'delivery-id', undefined, undefined, 'text', controls);
  const body = JSON.parse((request.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
  if (channel === 'telegram') {
    expect(body).toMatchObject({chat_id: '123', message_thread_id: 456, text, reply_markup: {inline_keyboard: controls.map(c => [{text: c.label, callback_data: c.data}])}});
  } else if (channel === 'discord') {
    expect(body).toMatchObject({content: text, allowed_mentions: {parse: []}, components: [{type: 1, components: controls.map(c => ({type: 2, style: 2, label: c.label, custom_id: c.data}))}]});
  } else if (channel === 'slack') {
    expect(body).toMatchObject({channel: '123', thread_ts: '456', text, mrkdwn: false, blocks: [{type: 'section', text: {type: 'plain_text', text}}, {type: 'actions', elements: controls.map(c => ({type: 'button', text: {type: 'plain_text', text: c.label}, action_id: c.data, value: c.data}))}]});
  } else {
    expect(body).toMatchObject({to: '123', messages: [{type: 'text', text, quickReply: {items: controls.map(c => ({type: 'action', action: {type: 'postback', label: c.label, data: c.data}}))}}]});
  }
});

test('durable controls appear only on the final chunk and survive an explicit retry with a new outbox instance', async () => {
  const store = new OrchestrationStore(':memory:', 'a');
  let rejectFinal = true;
  const send = jest.fn<ReturnType<ChannelSender>, Parameters<ChannelSender>>(async (_binding, _text, _id, _file, _speech, _format, buttons) => buttons && rejectFinal
    ? {state: 'failed', code: 'PROVIDER_HTTP_429'} : {state: 'delivered', providerId: 'receipt'});
  const delivery = new DeliveryOutbox(store, send);
  try {
    const input = store.acceptInput({scope: {agentId: 'a', agentSessionId: 's', source: 'discord', accountId: 'bot', principalId: 'user', chatId: '123', threadKey: ''}, text: 'start'});
    const decisions = new DecisionService(store, (r, b, text) => delivery.enqueue(r, b, text, controls));
    const text = 'Question details '.repeat(300) + '\nPlease reply with your answer.';
    decisions.finish(decisions.begin(input.conversationId, 'user', [input.inputId]), text);
    const rows = store.all("SELECT * FROM outbox WHERE kind='delivery' ORDER BY rowid");
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.slice(0, -1).every(row => !JSON.parse(String(row.payload_json)).controls)).toBe(true);
    expect(JSON.parse(String(rows[rows.length - 1].payload_json)).controls).toEqual(controls);
    await delivery.tick();
    expect(send.mock.calls.map(call => call[1]).join('')).toBe(text);
    expect(send.mock.calls.slice(0, -1).every(call => call[6] === undefined)).toBe(true);
    expect(send.mock.calls[send.mock.calls.length - 1][6]).toEqual(controls);
    await delivery.tick();
    expect(send).toHaveBeenCalledTimes(rows.length);
    // Definite rejections may be explicitly retried; no provider acceptance is assumed.
    store.run("UPDATE outbox SET state='pending' WHERE state='failed'");
    store.run("UPDATE deliveries SET state='pending' WHERE state='failed'");
    rejectFinal = false;
    await new DeliveryOutbox(store, send).tick();
    expect(send).toHaveBeenCalledTimes(rows.length + 1);
    expect(send.mock.calls[rows.length]).toEqual(send.mock.calls[rows.length - 1]);
    expect(store.get('SELECT attempt_count FROM outbox WHERE id=?', rows[rows.length - 1].id)?.attempt_count).toBe(2);
    expect(store.get("SELECT COUNT(*) n FROM outbox WHERE kind='delivery' AND state!='completed'")?.n).toBe(0);
  } finally { store.close(); }
});

test('Telegram keeps controls when a definite formatting rejection retries as plain text', async () => {
  const request = jest.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({description: "Bad Request: can't parse entities"}), {status: 400}))
    .mockResolvedValueOnce(new Response(JSON.stringify({ok: true, result: {message_id: 1}})));
  await channelSender(config, request)({channel: 'telegram', chat_id: '123', thread_key: ''}, '<b>Question?</b>', 'id', undefined, undefined, 'HTML', controls);
  const retry = JSON.parse(request.mock.calls[1][1].body);
  expect(retry.text).toBe('Question?');
  expect(retry.parse_mode).toBeUndefined();
  expect(retry.reply_markup.inline_keyboard[0][0].callback_data).toBe(controls[0].data);
});

test.each(['whatsapp', 'wechat'])('%s retains caller-provided command fallback', async channel => {
  const linked = jest.fn(async () => ({state: 'delivered' as const}));
  const text = 'Question?\n/task_question 05e29cb7-26ac-4881-a408-4182ffcb00e7 snooze';
  const binding = {channel, chat_id: '123', thread_key: ''};
  await channelSender(config, fetch, () => true, linked)(binding, text, 'id', undefined, undefined, 'text', controls);
  expect(linked).toHaveBeenCalledWith(binding, text, 'id', undefined, undefined, 'text');
});
