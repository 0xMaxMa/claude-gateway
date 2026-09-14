import { mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join, extname } from 'path';
import { randomUUID } from 'crypto';
import { AgentConfig } from '../types';
import { OrchestrationError } from './types';
import { ingestOrchestrationMedia } from './media';

/** Resolve provider-only attachment references before acknowledging receiver ingress. */
export async function receiveChannelMedia(agent: AgentConfig, agentsRoot: string, source: string, chatId: string, ref: string, request: typeof fetch = fetch): Promise<string> {
  if (!ref || ref.length > 8192) throw new OrchestrationError('INVALID_ATTACHMENT');
  let url: string;
  if (source === 'telegram' && agent.telegram?.botToken) {
    const response = await request(`https://api.telegram.org/bot${agent.telegram.botToken}/getFile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: ref }), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new OrchestrationError('ATTACHMENT_UNAVAILABLE');
    const body = await response.json() as { ok: boolean; result?: { file_path?: string; file_size?: number } };
    const path = body.result?.file_path;
    if (!body.ok || !path || path.split('/').some(part => part === '..') || !/^[A-Za-z0-9_./-]+$/.test(path)) throw new OrchestrationError('INVALID_ATTACHMENT');
    if ((body.result?.file_size ?? 0) > 20 * 1024 * 1024) throw new OrchestrationError('ATTACHMENT_TOO_LARGE');
    url = `https://api.telegram.org/file/bot${agent.telegram.botToken}/${path}`;
  } else if (source === 'discord') {
    const parsed = new URL(ref);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !['cdn.discordapp.com', 'media.discordapp.net'].includes(parsed.hostname)) throw new OrchestrationError('INVALID_ATTACHMENT');
    url = parsed.href;
  } else throw new OrchestrationError('ATTACHMENT_NOT_CONFIGURED');
  const response = await request(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok || !response.body) throw new OrchestrationError('ATTACHMENT_UNAVAILABLE');
  const limit = (source === 'telegram' ? 20 : 50) * 1024 * 1024;
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
