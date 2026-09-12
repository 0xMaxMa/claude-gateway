import { stripMarkdownPreservingUrls } from '../agent/line-pure';
import { describeVoiceError } from '../voice/errors';
import { resolveTelegramReplyFormat } from '../telegram/markdown';
import { chunkText, htmlToPlain } from '../telegram/chunks';
import { orderLineRequest } from '../shared/line-request-order';
import { sendChannelSpeech } from './channel-speech';
import { SpeechDelivery } from './telegram-speech';
import { randomUUID } from 'crypto';
import type { AgentConfig } from '../types';
import { OrchestrationStore, Row } from './store';
import { sendChannelFile, ChannelFile } from './file-delivery';

export type DeliveryOutcome = { state: 'delivered'; providerId?: string } | { state: 'failed' | 'unknown'; code: string; speechSynthesisFailed?: boolean };
export type ChannelSender = (binding: Row, text: string, deliveryId: string, file?: ChannelFile, speech?: SpeechDelivery, textFormat?: 'HTML' | 'text') => Promise<DeliveryOutcome>;

/** A transport receipt means provider acceptance, never that a human read it.
 * Ambiguous network failures are retained for reconciliation, not blind retry. */
export function channelSender(config: AgentConfig | (() => AgentConfig), request: typeof fetch = fetch, speechEnabled: (binding: Row, speech: SpeechDelivery) => boolean = () => true, linkedSender?: ChannelSender): ChannelSender {
  return async (binding, text, id, file, speech, textFormat) => {
    const agent = typeof config === 'function' ? config() : config;
    if (speech) return sendChannelSpeech(agent, binding, speech, id, request, undefined, () => speechEnabled(binding, speech));
    if (['whatsapp', 'wechat'].includes(String(binding.channel))) {
      if (!linkedSender) return {state: 'failed', code: 'DELIVERY_NOT_CONFIGURED'};
      return linkedSender(binding, text, id, file, speech, textFormat);
    }
    if (file) return sendChannelFile(agent, binding, file, id, request);
    const source = String(binding.channel), chat = String(binding.chat_id), thread = String(binding.thread_key);
    let url: string, body: object;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (source === 'telegram' && agent.telegram?.botToken) {
      url = `https://api.telegram.org/bot${agent.telegram.botToken}/sendMessage`;
      const formatted = textFormat ? { sendText: text, parseMode: textFormat === 'HTML' ? 'HTML' : undefined } : resolveTelegramReplyFormat(text);
      body = { chat_id: chat, text: formatted.sendText, ...(formatted.parseMode ? { parse_mode: formatted.parseMode } : {}), ...(thread ? { message_thread_id: Number(thread) } : {}) };
    } else if (source === 'discord' && agent.discord?.botToken) {
      url = `https://discord.com/api/v10/channels/${encodeURIComponent(chat)}/messages`;
      headers.Authorization = `Bot ${agent.discord.botToken}`;
      body = { content: text, nonce: id.replace(/-/g, '').slice(0, 25), enforce_nonce: true, allowed_mentions: { parse: [] } };
    } else if (source === 'line' && agent.line?.channelAccessToken) {
      url = 'https://api.line.me/v2/bot/message/push';
      headers.Authorization = `Bearer ${agent.line.channelAccessToken}`; headers['X-Line-Retry-Key'] = id;
      body = { to: chat, messages: [{ type: 'text', text: textFormat === 'text' ? text : stripMarkdownPreservingUrls(text) }] };
    } else if (source === 'slack' && agent.slack?.botToken) {
      url = 'https://slack.com/api/chat.postMessage'; headers.Authorization = `Bearer ${agent.slack.botToken}`;
      body = { channel: chat, text, ...(thread ? { thread_ts: thread } : {}), unfurl_links: false, unfurl_media: false };
    } else if (source === 'whatsapp_cloud' && agent.whatsapp_cloud?.accessToken && agent.whatsapp_cloud.phoneNumberId) {
      url = `https://graph.facebook.com/v20.0/${encodeURIComponent(agent.whatsapp_cloud.phoneNumberId)}/messages`;
      headers.Authorization = `Bearer ${agent.whatsapp_cloud.accessToken}`;
      body = {messaging_product: 'whatsapp', to: chat, type: 'text', text: {body: text}};
    } else return { state: 'failed', code: 'DELIVERY_NOT_CONFIGURED' };
    try {
      const send = () => request(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      let response = await (source === 'line' ? orderLineRequest(agent.id, chat, send) : send());
      if (source === 'telegram' && response.status === 400 && 'parse_mode' in body) {
        const rejection = await response.clone().json().catch(() => ({})) as {description?: string};
        if (/can't parse entities/i.test(rejection.description ?? '')) {
          // A definite parse rejection was not delivered; only this case permits a plain retry.
          const {parse_mode: _format, ...plain} = body as {parse_mode: string; text: string};
          body = {...plain, text: htmlToPlain(plain.text)};
          response = await send();
        }
      }
      if (source === 'line' && response.status === 409 && response.headers.get('x-line-accepted-request-id')) return { state: 'delivered', providerId: response.headers.get('x-line-accepted-request-id')! };
      if (!response.ok) return { state: response.status >= 500 ? 'unknown' : 'failed', code: `PROVIDER_HTTP_${response.status}` };
      const result = await response.json() as { ok?: boolean; error?: unknown; messages?: Array<{id: string}>; id?: string; ts?: string; result?: { message_id?: number }; sentMessages?: Array<{ id: string }> };
      if (result.ok === false || result.error) return { state: 'failed', code: 'PROVIDER_REJECTED' };
      if (source === 'whatsapp_cloud' && !result.messages?.[0]?.id) return {state: 'unknown', code: 'PROVIDER_RECEIPT_UNKNOWN'};
      return { state: 'delivered', providerId: result.messages?.[0]?.id ?? result.id ?? result.ts ?? (result.result?.message_id === undefined ? undefined : String(result.result.message_id)) ?? result.sentMessages?.[0]?.id };
    } catch { return { state: 'unknown', code: 'PROVIDER_RECEIPT_UNKNOWN' }; }
  };
}

/** Channel notices share one provider-independent vocabulary; details stay in logs. */
export function speechFailureNotice(code: string): string {
  const diagnostic = describeVoiceError(code);
  const messages: Record<string, [string, string]> = {
    quota: ['Voice quota exhausted', 'Try again after the quota resets'],
    daily_quota: ['Voice quota exhausted', 'Try again after the quota resets'],
    quota_or_rate_limit: ['Voice rate limit or quota reached', 'Check provider usage'],
    rate_limit: ['Voice rate limit reached', 'Try again later'],
    payment: ['Voice credits or billing required', 'Check provider billing'],
    authentication: ['Voice authentication failed', 'Check your API key'],
    permission: ['Voice access denied', 'Check provider permissions'],
    unavailable: ['Voice provider unavailable', 'Try again later'],
    timeout: ['Voice request timed out', 'Try again later'],
    network: ['Voice connection failed', 'Try again later'],
    language: ['Voice language not supported', 'Check voice settings'],
    model: ['Voice model or voice unavailable', 'Check voice settings'],
    invalid_request: ['Voice request rejected', 'Check voice settings'],
    invalid_response: ['Voice audio could not be created', 'Try again later'],
    cancelled: ['Voice request cancelled', 'Try again'],
    unknown: ['Voice audio unavailable', 'Try again later'],
  };
  const [reason, action] = messages[diagnostic.category] ?? messages.unknown;
  return `${reason}${diagnostic.httpStatus ? ` (HTTP ${diagnostic.httpStatus})` : ''}. ${action}, or use /voice off.`;
}

export class DeliveryOutbox {
  private active?: Promise<void>;
  constructor(private readonly store: OrchestrationStore, private readonly send: ChannelSender) {}
  /** Called inside the decision commit transaction. Each chunk has its own receipt. */
  enqueue(responseId: string, bindingId: string, text: string): void {
    const binding = this.store.get('SELECT channel FROM conversation_bindings WHERE id=?', bindingId);
    // Normalize the complete reply so Markdown delimiters never straddle chunks.
    if (binding?.channel === 'line') text = stripMarkdownPreservingUrls(text);
    let formatted = binding?.channel === 'telegram' ? resolveTelegramReplyFormat(text) : { sendText: text, parseMode: undefined };
    // Format before splitting so code fences and emphasis can span receipts.
    let chunks = binding?.channel === 'telegram'
      ? chunkText(formatted.sendText, 1900, formatted.parseMode === 'HTML')
      : Array.from(text).reduce<string[]>((parts, character) => {
        if (!parts.length || parts[parts.length - 1].length + character.length > 1900) parts.push('');
        parts[parts.length - 1] += character; return parts;
      }, []);
    if (formatted.parseMode && chunks.some(part => part.length > 1900)) {
      formatted = {sendText: htmlToPlain(formatted.sendText), parseMode: undefined};
      chunks = chunkText(formatted.sendText, 1900);
    }
    for (const [index, content] of chunks.filter(part => part.length > 0).entries()) {
      const id = randomUUID();
      this.store.run('INSERT INTO deliveries VALUES(?,?,?,?,?,?,?,?,?,?)', id, responseId, null, bindingId, 'text', 'pending', null, content, null, Date.now());
      this.store.enqueue('delivery', `delivery:${responseId}:${index}`, { deliveryId: id, textFormat: binding?.channel === 'telegram' ? formatted.parseMode ?? 'text' : binding?.channel === 'line' ? 'text' : undefined });
    }
    for (const file of this.store.all('SELECT * FROM task_files WHERE response_id=? ORDER BY created_at,id', responseId)) {
      const id = randomUUID();
      this.store.run('INSERT INTO deliveries VALUES(?,?,?,?,?,?,?,?,?,?)', id, responseId, null, bindingId, String(file.kind), 'pending', null, JSON.stringify({ path: file.path, name: file.name, kind: file.kind, caption: file.caption }), null, Date.now());
      this.store.enqueue('delivery', `file:${responseId}:${file.id}`, { deliveryId: id });
    }
  }
  enqueueSpeech(responseId: string, bindingId: string, speech: SpeechDelivery): void {
    if (!speech.text.trim() || speech.text.length > 600 || speech.text.includes('```')) return;
    const key = `speech:${responseId}`;
    if (this.store.get('SELECT id FROM outbox WHERE dedup_key=?', key)) return;
    const id = randomUUID();
    this.store.run('INSERT INTO deliveries VALUES(?,?,?,?,?,?,?,?,?,?)', id, responseId, null, bindingId, 'speech', 'pending', null, JSON.stringify(speech), null, Date.now());
    this.store.enqueue('delivery', key, { deliveryId: id });
  }
  tick(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.run().finally(() => { this.active = undefined; });
    return this.active;
  }
  private async run(): Promise<void> {
    // Page past blocked responses without retrying ambiguous provider receipts.
    // A fixed high-water mark also bounds this tick when new work arrives mid-send.
    const ceiling = Number(this.store.get('SELECT COALESCE(MAX(rowid),0) n FROM outbox')!.n);
    let cursor = 0, sent = 0;
    while (sent < 20) {
      const rows = this.store.all("SELECT rowid AS sequence,* FROM outbox WHERE kind='delivery' AND state='pending' AND rowid>? AND rowid<=? ORDER BY rowid LIMIT 20", cursor, ceiling);
      if (!rows.length) break;
      for (const row of rows) {
        cursor = Number(row.sequence);
        const payload = JSON.parse(String(row.payload_json));
        const id = payload.deliveryId as string;
        const delivery = this.store.get('SELECT * FROM deliveries WHERE id=?', id)!;
        const binding = this.store.get('SELECT * FROM conversation_bindings WHERE id=?', delivery.binding_id)!;
        if (delivery.modality === 'speech') {
          const textRows = this.store.all("SELECT state FROM deliveries WHERE response_id=? AND modality='text'", delivery.response_id);
          if (!textRows.length || textRows.some(text => text.state !== 'delivered')) continue;
        }
        // Text must never wait behind an early speech row (including rows from older runtimes).
        const earlier = payload.speechFailureFor ? undefined : this.store.get(`SELECT id FROM deliveries WHERE response_id=? AND rowid < (SELECT rowid FROM deliveries WHERE id=?)
          AND state!='delivered' AND NOT (modality='speech' AND (state IN ('failed','unknown') OR ?!='speech')) LIMIT 1`, delivery.response_id, id, delivery.modality);
        if (earlier) continue;
        sent++;
        this.store.transaction(() => {
          this.store.run("UPDATE outbox SET state='processing',attempt_count=attempt_count+1 WHERE id=?", row.id);
          this.store.run("UPDATE deliveries SET state='sending' WHERE id=?", id);
        });
        const result = await (delivery.modality === 'speech'
          ? this.send(binding, '', id, undefined, JSON.parse(String(delivery.delivered_text)))
          : this.send(binding, delivery.modality === 'text' ? String(delivery.delivered_text) : '', id,
            delivery.modality === 'text' ? undefined : JSON.parse(String(delivery.delivered_text)), undefined, payload.textFormat)).catch(() => ({ state: 'unknown' as const, code: 'PROVIDER_RECEIPT_UNKNOWN' }));
        this.store.transaction(() => {
          this.store.run('UPDATE deliveries SET state=?,provider_message_id=?,updated_at=? WHERE id=?', result.state, result.state === 'delivered' ? result.providerId ?? null : null, Date.now(), id);
          this.store.run('UPDATE outbox SET state=?,last_error=? WHERE id=?', result.state === 'delivered' ? 'completed' : result.state, result.state === 'delivered' ? null : result.code, row.id);
          if (delivery.modality === 'speech' && result.state === 'failed' && result.speechSynthesisFailed) {
            const key = `speech-failure:${id}`;
            if (!this.store.get('SELECT id FROM outbox WHERE dedup_key=?', key)) {
              const noticeId = randomUUID();
              const diagnostic = describeVoiceError(result.code);
              const text = speechFailureNotice(result.code);
              this.store.run('INSERT INTO deliveries VALUES(?,?,?,?,?,?,?,?,?,?)', noticeId, delivery.response_id, null, delivery.binding_id, 'text', 'pending', null, text, null, Date.now());
              this.store.enqueue('delivery', key, { deliveryId: noticeId, textFormat: 'text', speechFailureFor: id });
              const speech = JSON.parse(String(delivery.delivered_text)) as SpeechDelivery;
              console.warn(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', event: 'Speech synthesis failed', agentId: this.store.agentId, channel: binding.channel, referenceId: id, provider: speech.provider, model: speech.model, code: result.code, ...diagnostic }));
            }
          }
        });
        if (sent >= 20) break;
      }
    }
  }
}
