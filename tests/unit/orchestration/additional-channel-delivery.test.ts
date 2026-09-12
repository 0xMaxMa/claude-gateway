import { channelSender } from '../../../src/orchestration/delivery';
import { sendChannelFile } from '../../../src/orchestration/file-delivery';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AgentConfig } from '../../../src/types';

const config = {id: 'a', whatsapp_cloud: {accessToken: 'token', phoneNumberId: 'phone'}} as AgentConfig;
const receipt = () => new Response(JSON.stringify({messages: [{id: 'receipt'}]}), {status: 200});

test.each(['whatsapp', 'wechat'])('%s uses the linked runner transport and preserves the binding', async channel => {
  const linked = jest.fn(async () => ({state: 'delivered' as const}));
  const request = jest.fn();
  const binding = {channel, chat_id: 'chat', thread_key: 'whatsapp-account:second'};
  await expect(channelSender(config, request, () => false, linked)(binding, 'hello', 'id')).resolves.toEqual({state: 'delivered'});
  expect(linked).toHaveBeenCalledWith(binding, 'hello', 'id', undefined, undefined, undefined);
  expect(request).not.toHaveBeenCalled();
});

test('Cloud API accepts text receipts and surfaces provider rejections', async () => {
  const request = jest.fn().mockResolvedValueOnce(receipt()).mockResolvedValueOnce(new Response(JSON.stringify({error: {message: 'rejected'}})));
  const send = channelSender(config, request);
  const binding = {channel: 'whatsapp_cloud', chat_id: 'recipient', thread_key: ''};
  await expect(send(binding, 'hello', 'id')).resolves.toEqual({state: 'delivered', providerId: 'receipt'});
  expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({messaging_product: 'whatsapp', to: 'recipient', type: 'text', text: {body: 'hello'}});
  await expect(send(binding, 'hello', 'id2')).resolves.toEqual({state: 'failed', code: 'PROVIDER_REJECTED'});
});

test('Cloud file delivery validates media containment then uploads and sends the media ID', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-media-'));
  const media = join(root, 'a', 'media'); mkdirSync(media, {recursive: true});
  const path = join(media, 'note.pdf'); writeFileSync(path, '%PDF-1.4 attachment');
  const request = jest.fn().mockResolvedValueOnce(new Response(JSON.stringify({id: 'media-id'}))).mockResolvedValueOnce(receipt());
  const agent = {...config, workspace: join(root, 'a', 'workspace')};
  const binding = {channel: 'whatsapp_cloud', chat_id: 'recipient', thread_key: ''};
  try {
    await expect(sendChannelFile(agent, binding, {path, name: 'note.pdf', kind: 'file', caption: 'note'}, 'id', request)).resolves.toEqual({state: 'delivered', providerId: 'receipt'});
    expect(request.mock.calls[0][1].body.get('type')).toBe('application/pdf');
    expect(JSON.parse(request.mock.calls[1][1].body)).toMatchObject({type: 'document', document: {id: 'media-id', filename: 'note.pdf'}});
    const outside = join(root, 'private.txt'); writeFileSync(outside, 'private');
    await expect(sendChannelFile(agent, binding, {path: outside, name: 'private.txt', kind: 'file', caption: ''}, 'id2', request)).resolves.toEqual({state: 'failed', code: 'ATTACHMENT_UNAVAILABLE'});
    expect(request).toHaveBeenCalledTimes(2);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('runner sends linked WhatsApp replies on the original account, not the last active account', async () => {
  const {AgentRunner} = await import('../../../src/agent/runner');
  const sendWhatsAppMessage = jest.fn(async () => {});
  const sendWeChatMessage = jest.fn(async () => {});
  const runner = Object.assign(Object.create(AgentRunner.prototype), {agentConfig: config, sendWhatsAppMessage, sendWeChatMessage});
  await expect(runner.sendLinkedOrchestrationChannel({channel: 'whatsapp', chat_id: 'chat', thread_key: 'whatsapp-account:first'}, 'hello', 'id')).resolves.toEqual({state: 'delivered'});
  expect(sendWhatsAppMessage).toHaveBeenCalledWith('chat', 'hello', undefined, 'first', {asDocument: false});
  await runner.sendLinkedOrchestrationChannel({channel: 'wechat', chat_id: 'chat'}, 'hello', 'id');
  expect(sendWeChatMessage).toHaveBeenCalledWith('chat', 'hello');
  sendWeChatMessage.mockRejectedValueOnce(new Error('Connection lost'));
  await expect(runner.sendLinkedOrchestrationChannel({channel: 'wechat', chat_id: 'chat'}, 'hello', 'id')).resolves.toEqual({state: 'unknown', code: 'PROVIDER_RECEIPT_UNKNOWN'});
});

test('linked channel menus expose usable commands and preserve the WhatsApp account', async () => {
  const {AgentRunner} = await import('../../../src/agent/runner');
  const sendWhatsAppMessage = jest.fn(async () => {});
  const runner = Object.assign(Object.create(AgentRunner.prototype), {agentConfig: config, sendWhatsAppMessage});
  await runner.sendOrchestrationControl('whatsapp', 'chat', {text: 'Tasks', buttons: [{label: 'Stop', data: 'orch:token'}]}, {account_id: 'second'});
  expect(sendWhatsAppMessage).toHaveBeenCalledWith('chat', 'Tasks\nStop: /orch token', undefined, 'second', {asDocument: false});
});

test('Cloud success without a message receipt remains ambiguous', async () => {
  const request = jest.fn(async () => new Response('{}'));
  await expect(channelSender(config, request)({channel: 'whatsapp_cloud', chat_id: 'chat'}, 'hello', 'id')).resolves.toEqual({state: 'unknown', code: 'PROVIDER_RECEIPT_UNKNOWN'});
});
