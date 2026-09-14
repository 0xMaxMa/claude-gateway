import { orderLineRequest } from '../shared/line-request-order';
import { readFileSync, realpathSync, statSync } from 'fs';
import { join, relative, isAbsolute } from 'path';
import { homedir } from 'os';
import type { AgentConfig } from '../types';
import type { Row } from './store';
import type { DeliveryOutcome } from './delivery';
import { MediaStore } from '../history/media-store';
import { ShareStore, shareEnv, validateShareFile, detectShareMime, detectAudioMime } from '../share/share-store';

export interface ChannelFile { path: string; name: string; kind: 'image' | 'file' | 'audio'; caption: string; durationMs?: number; }
export function resolveChannelFile(agent: AgentConfig, file: ChannelFile): {path: string; bytes: Buffer} {
  const agentsRoot = join(agent.workspace, '../..');
  let path: string, bytes: Buffer;
  try {
    path = realpathSync(MediaStore.resolvePath(agentsRoot, agent.id, file.path));
    const ref = relative(realpathSync(join(agentsRoot, agent.id, 'media')), path);
    if (!ref || ref.startsWith('..') || isAbsolute(ref) || statSync(path).size > 50 * 1024 * 1024) throw new Error();
    bytes = readFileSync(path);
    if (bytes.length > 50 * 1024 * 1024) throw new Error();
  } catch { throw new Error('ATTACHMENT_UNAVAILABLE'); }
  return {path, bytes};
}
export async function sendChannelFile(agent: AgentConfig, binding: Row, file: ChannelFile, id: string, request: typeof fetch, enabled: () => boolean = () => true): Promise<DeliveryOutcome> {
  if(!enabled())return {state:'failed',code:'VOICE_REPLY_DISABLED'};
  const agentsRoot = join(agent.workspace, '../..');
  const source = String(binding.channel), chat = String(binding.chat_id), thread = String(binding.thread_key);
  let path: string, bytes: Buffer;
  try { ({path, bytes} = resolveChannelFile(agent, file)); }
  catch { return {state: 'failed', code: 'ATTACHMENT_UNAVAILABLE'}; }
  const mime = file.kind==='audio' ? detectAudioMime(bytes.subarray(0,12)) ?? 'application/octet-stream' : detectShareMime(bytes.subarray(0, 12)) ?? 'application/octet-stream';
  const image = file.kind === 'image' && mime.startsWith('image/');
  const call = (url: string, init: RequestInit) => {
    const send = () => request(url, { ...init, signal: AbortSignal.timeout(30000) });
    return source === 'line' ? orderLineRequest(agent.id, chat, send) : send();
  };
  let response: Response;
  try {
    if (source === 'telegram' && agent.telegram?.botToken) {
      const form = new FormData(), photo = image && bytes.length <= 10 * 1024 * 1024;
      form.set('chat_id', chat); if (thread) form.set('message_thread_id', thread);
      if (file.caption) form.set('caption', file.caption);
      form.set(photo ? 'photo' : 'document', new Blob([new Uint8Array(bytes)], { type: mime }), file.name);
      response = await call(`https://api.telegram.org/bot${agent.telegram.botToken}/${photo ? 'sendPhoto' : 'sendDocument'}`, { method: 'POST', body: form });
    } else if (source === 'whatsapp_cloud' && agent.whatsapp_cloud?.accessToken && agent.whatsapp_cloud.phoneNumberId) {
      const url = `https://graph.facebook.com/v20.0/${encodeURIComponent(agent.whatsapp_cloud.phoneNumberId)}`;
      const headers = {Authorization: `Bearer ${agent.whatsapp_cloud.accessToken}`};
      const form = new FormData();
      form.set('messaging_product', 'whatsapp'); form.set('type', mime);
      form.set('file', new Blob([new Uint8Array(bytes)], {type: mime}), file.name);
      const upload = await call(`${url}/media`, {method: 'POST', headers, body: form});
      if (!upload.ok) return {state: upload.status >= 500 ? 'unknown' : 'failed', code: `PROVIDER_HTTP_${upload.status}`};
      const media = await upload.json() as {id?: string; error?: unknown};
      if (!media.id || media.error) return {state: 'failed', code: 'UPLOAD_REJECTED'};
      if (!enabled()) return {state: 'failed', code: 'VOICE_REPLY_DISABLED'};
      const type = image ? 'image' : file.kind === 'audio' ? 'audio' : 'document';
      response = await call(`${url}/messages`, {method: 'POST', headers: {...headers, 'Content-Type': 'application/json'},
        body: JSON.stringify({messaging_product: 'whatsapp', to: chat, type,
          [type]: {id: media.id, ...(type === 'document' ? {filename: file.name} : {}), ...(type !== 'audio' && file.caption ? {caption: file.caption} : {})}})});
    } else if (source === 'discord' && agent.discord?.botToken) {
      const form = new FormData();
      form.set('payload_json', JSON.stringify({ content: file.caption, attachments: [{ id: 0, filename: file.name }], nonce: id.replace(/-/g, '').slice(0,25), enforce_nonce: true, allowed_mentions: { parse: [] } }));
      form.set('files[0]', new Blob([new Uint8Array(bytes)], { type: mime }), file.name);
      response = await call(`https://discord.com/api/v10/channels/${encodeURIComponent(chat)}/messages`, { method: 'POST', headers: { Authorization: `Bot ${agent.discord.botToken}` }, body: form });
    } else if (source === 'slack' && agent.slack?.botToken) {
      const authorization = { Authorization: `Bearer ${agent.slack.botToken}` };
      const reserve = await call('https://slack.com/api/files.getUploadURLExternal', { method: 'POST', headers: authorization, body: new URLSearchParams({ filename: file.name, length: String(bytes.length) }) });
      if (!reserve.ok) return { state: reserve.status >= 500 ? 'unknown' : 'failed', code: `PROVIDER_HTTP_${reserve.status}` };
      const slot = await reserve.json() as { ok: boolean; upload_url: string; file_id: string };
      if (!slot.ok || !slot.file_id || !slot.upload_url?.startsWith('https://')) return { state: 'failed', code: 'UPLOAD_SLOT_REJECTED' };
      const form = new FormData(); form.set('file', new Blob([new Uint8Array(bytes)],{type:mime}), file.name);
      const upload = await call(slot.upload_url, { method: 'POST', body: form });
      if (!upload.ok) return { state: 'unknown', code: 'UPLOAD_RECEIPT_UNKNOWN' };
      if(!enabled())return {state:'failed',code:'VOICE_REPLY_DISABLED'};
      response = await call('https://slack.com/api/files.completeUploadExternal', { method: 'POST', headers: { ...authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: [{ id: slot.file_id, title: file.name }], channel_id: chat, ...(thread ? { thread_ts: thread } : {}), ...(file.caption ? { initial_comment: file.caption } : {}) }) });
    } else if (source === 'line' && agent.line?.channelAccessToken) {
      const base = readFileSync(join(agent.workspace, '../.public-base'), 'utf8').trim().replace(/\/+$/, '');
      if (!base.startsWith('https://')) return { state: 'failed', code: 'PUBLIC_MEDIA_URL_REQUIRED' };
      const validated = validateShareFile(agentsRoot, agent.id, path, 20 * 1024 * 1024, image ? 'image' : file.kind==='audio' ? 'audio' : 'any');
      const shares = new ShareStore(shareEnv('DB_PATH') || join(homedir(), '.claude-gateway', 'shares.db'));
      let url: string;
      try {
        const share = shares.mintShare({ agentId: agent.id, sessionId: String(binding.conversation_id), relativePath: validated.relativePath,
          dedupeRef: file.path, purpose: 'channel_delivery', ttlSeconds: 1800, allowKind: image ? 'image' : file.kind==='audio' ? 'audio' : 'any' });
        url = `${base}/shared/${share.token}${file.kind==='audio' ? (mime==='audio/mp4'?'/audio.m4a':'/audio.mp3') : ''}`;
      } finally { shares.close(); }
      const message = file.kind==='audio' ? {type:'audio',originalContentUrl:url,duration:file.durationMs} : image ? { type: 'image', originalContentUrl: url, previewImageUrl: url } : { type: 'text', text: `${file.name}\n${url}` };
      if(!enabled())return {state:'failed',code:'VOICE_REPLY_DISABLED'};
      response = await call('https://api.line.me/v2/bot/message/push', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${agent.line.channelAccessToken}`, 'X-Line-Retry-Key': id }, body: JSON.stringify({ to: chat, messages: [message] }) });
      if (response.status === 409 && response.headers.get('x-line-accepted-request-id')) return { state: 'delivered', providerId: response.headers.get('x-line-accepted-request-id')! };
    } else return { state: 'failed', code: 'DELIVERY_NOT_CONFIGURED' };
    if (!response.ok) return { state: response.status >= 500 ? 'unknown' : 'failed', code: `PROVIDER_HTTP_${response.status}` };
    const result = await response.json() as { ok?: boolean; error?: unknown; messages?: Array<{id: string}>; id?: string; result?: { message_id?: number }; files?: Array<{ id: string }>; sentMessages?: Array<{ id: string }> };
    if (result.ok === false || result.error) return { state: 'failed', code: 'PROVIDER_REJECTED' };
    if (source === 'whatsapp_cloud' && !result.messages?.[0]?.id) return {state: 'unknown', code: 'PROVIDER_RECEIPT_UNKNOWN'};
    return { state: 'delivered', providerId: result.messages?.[0]?.id ?? result.id ?? result.files?.[0]?.id ?? result.sentMessages?.[0]?.id ?? (result.result?.message_id === undefined ? undefined : String(result.result.message_id)) };
  } catch { return { state: 'unknown', code: 'PROVIDER_RECEIPT_UNKNOWN' }; }
}
