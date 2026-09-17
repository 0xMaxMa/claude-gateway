import { mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join, extname } from 'path';
import { randomUUID } from 'crypto';
import { AgentConfig } from '../types';
import { OrchestrationError } from './types';
import { ingestOrchestrationMedia } from './media';
import { ChannelMediaError, channelMediaHttpError, classifyChannelMediaError } from './channel-media-error';

/** Resolve provider-only attachment references before acknowledging receiver ingress. */
export async function receiveChannelMedia(agent: AgentConfig, agentsRoot: string, source: string, chatId: string, ref: string, request: typeof fetch = fetch, size?: number): Promise<string> {
  try {
    return await receive(agent, agentsRoot, source, chatId, ref, request, size);
  } catch (error) { throw classifyChannelMediaError(error); }
}

async function receive(agent: AgentConfig, agentsRoot: string, source: string, chatId: string, ref: string, request: typeof fetch, size?: number): Promise<string> {
  const limit = (source === 'telegram' ? 20 : 50) * 1024 * 1024;
  if (size !== undefined && (!Number.isSafeInteger(size) || size < 0)) throw new OrchestrationError('INVALID_ATTACHMENT');
  if (size !== undefined && size > limit) throw new OrchestrationError('ATTACHMENT_TOO_LARGE');
  if (!ref || ref.length > 8192) throw new OrchestrationError('INVALID_ATTACHMENT');
  let url: string;
  if (source === 'telegram' && agent.telegram?.botToken) {
    const response = await request(`https://api.telegram.org/bot${agent.telegram.botToken}/getFile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: ref }), signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      const errorBody = await response.json().catch(() => undefined) as {parameters?: {retry_after?: number}} | undefined;
      const retryAfter = response.headers.get('retry-after') ?? (typeof errorBody?.parameters?.retry_after === 'number' ? String(errorBody.parameters.retry_after) : undefined);
      throw channelMediaHttpError(response.status, retryAfter);
    }
    const body = await response.json() as { ok: boolean; error_code?: number; parameters?: {retry_after?: number}; result?: { file_path?: string; file_size?: number } };
    if (!body.ok) {
      const status = body.error_code;
      throw status && Number.isInteger(status) && status >= 400 && status <= 599
        ? channelMediaHttpError(status, body.parameters?.retry_after === undefined ? undefined : String(body.parameters.retry_after))
        : new ChannelMediaError('ATTACHMENT_UNAVAILABLE', true);
    }
    const path = body.result?.file_path;
    if (!body.ok || !path || path.split('/').some(part => part === '..') || !/^[A-Za-z0-9_./-]+$/.test(path)) throw new OrchestrationError('INVALID_ATTACHMENT');
    if ((body.result?.file_size ?? 0) > 20 * 1024 * 1024) throw new OrchestrationError('ATTACHMENT_TOO_LARGE');
    url = `https://api.telegram.org/file/bot${agent.telegram.botToken}/${path}`;
  } else if (source === 'discord') {
    let parsed: URL;
    try { parsed = new URL(ref); } catch { throw new OrchestrationError('INVALID_ATTACHMENT'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !['cdn.discordapp.com', 'media.discordapp.net'].includes(parsed.hostname)) throw new OrchestrationError('INVALID_ATTACHMENT');
    url = parsed.href;
  } else throw new OrchestrationError('ATTACHMENT_NOT_CONFIGURED');
  const response = await request(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw channelMediaHttpError(response.status, response.headers.get('retry-after'));
  if (!response.body) throw new ChannelMediaError('ATTACHMENT_UNAVAILABLE', true);
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    if (Number(response.headers.get('content-length')) > limit) throw new OrchestrationError('ATTACHMENT_TOO_LARGE');
    while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; if (bytes > limit) throw new OrchestrationError('ATTACHMENT_TOO_LARGE'); chunks.push(chunk.value); }
  } finally { await reader.cancel().catch(() => {}); }
  const directory = join(agentsRoot, agent.id, 'orchestration-inbox'); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `${randomUUID()}${extname(new URL(url).pathname).slice(0,12).replace(/[^A-Za-z0-9.]/g,'')}`);
  try { writeFileSync(temporary, Buffer.concat(chunks), { mode: 0o600, flag: 'wx' }); return ingestOrchestrationMedia(agentsRoot, agent.id, `${source}-${chatId}`, temporary); }
  finally { try { unlinkSync(temporary); } catch { /* no file before write */ } }
}
