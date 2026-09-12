import { VoiceReplyMode, VOICE_REPLY_MODES } from './voice-reply-policy';
import { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'fs';
import { dirname } from 'path';
import { createHash, randomUUID } from 'crypto';
import { ORCHESTRATION_SCHEMA_V1 } from './migrations/schema';
import { ConversationScope, OrchestrationError, OrchestrationEvent, InputModality, TaskSnapshot, TaskAttempt } from './types';
import type { ExecutionCapabilities } from './types';

export type Row = Record<string, string | number | null>;
export interface InputReceipt { inputId: string; conversationId: string; bindingId: string; }
export interface AcceptInput {
  /** Trusted installed-skill snapshot, retained for mailbox recovery. */
  skill?: import('./skills').TaskSkill;
  scope: ConversationScope;
  text: string;
  modality?: InputModality;
  attachmentIds?: string[];
  requestId?: string;
  storeUserMessage?: boolean;
  /** Stable provider/client identifier, scoped by trusted ingress before use. */
  ingressKey?: string;
  /** Only ingress supplies these; they survive a crash before agent admission. */
  capabilities?: ExecutionCapabilities;
  model?: string;
  metadata?: { senderName?: string; senderId?: string; platformMessageId?: string; promptContext?: string; imageRefs?: string[];
    attachmentName?: string; mediaType?: string; repliedText?: string };
  /** Internal mailbox replay identifier; never accepted from HTTP/model arguments. */
  acceptedInputId?: string;
  /** Receiver has already applied this platform's sender/group policy. */
  trustedChannelMember?: boolean;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export function payloadHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function boundedText(text: unknown, max = 65536): string {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > max) throw new OrchestrationError('INVALID_INPUT', 'Expected bounded nonempty text');
  return text;
}

export class OrchestrationStore {
  private readonly db: DatabaseSync;
  private inTransaction = false;
  constructor(readonly filename: string, readonly agentId: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    try {
      if (filename !== ':memory:') chmodSync(filename, 0o600);
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.transaction(() => {
        this.db.exec('CREATE TABLE IF NOT EXISTS orchestration_schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
        const version = this.get('SELECT MAX(version) AS version FROM orchestration_schema_migrations')?.version ?? 0;
        if (Number(version) > 1) throw new OrchestrationError('UNSUPPORTED_SCHEMA');
        if (!version) {
          this.db.exec(ORCHESTRATION_SCHEMA_V1);
          this.run('INSERT INTO orchestration_schema_migrations VALUES(1,?)', Date.now());
        }
        this.db.exec('CREATE TABLE IF NOT EXISTS response_audio(response_id TEXT PRIMARY KEY REFERENCES assistant_responses(id),audio BLOB NOT NULL,created_at INTEGER NOT NULL)');
        this.db.exec('CREATE TABLE IF NOT EXISTS telegram_tts_voices(chat_id TEXT PRIMARY KEY, provider TEXT NOT NULL, voice_id TEXT NOT NULL)');
        this.db.exec('CREATE TABLE IF NOT EXISTS telegram_voice_preferences(chat_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)))');
        this.db.exec("CREATE TABLE IF NOT EXISTS voice_reply_modes(chat_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('off','auto','on')))");
      });
      const foreign = this.get('SELECT id FROM conversations WHERE agent_id != ? LIMIT 1', agentId);
      if (foreign) throw new OrchestrationError('AGENT_STORE_MISMATCH');
    } catch (error) { this.db.close(); throw error; }
  }
  saveResponseAudio(responseId: string, audio: Buffer): void {
    if (!audio.length || audio.length > 16 * 1024 * 1024) return;
    this.transaction(() => {
      this.run('DELETE FROM response_audio WHERE created_at<?', Date.now() - 30 * 86400000);
      this.run('INSERT OR IGNORE INTO response_audio VALUES(?,?,?)', responseId, audio, Date.now());
      while (Number(this.get('SELECT COALESCE(SUM(length(audio)),0) AS n FROM response_audio')!.n) > 64 * 1024 * 1024)
        this.run('DELETE FROM response_audio WHERE response_id=(SELECT response_id FROM response_audio ORDER BY created_at,response_id LIMIT 1)');
    });
  }
  responseAudio(sessionId: string, responseId?: string): Buffer | string[] | undefined {
    const sql = ' FROM response_audio a JOIN assistant_responses r ON r.id=a.response_id JOIN conversations c ON c.id=r.conversation_id WHERE c.agent_session_id=? AND a.created_at>?';
    const cutoff = Date.now() - 30 * 86400000;
    if (!responseId) return this.all('SELECT a.response_id' + sql, sessionId, cutoff).map(r => String(r.response_id));
    const row = this.db.prepare('SELECT a.audio' + sql + ' AND a.response_id=?').get(sessionId, cutoff, responseId) as { audio: Uint8Array } | undefined;
    return row ? Buffer.from(row.audio) : undefined;
  }
  channelVoice(channel: string, chatId: string, thread = ''): boolean { return this.telegramVoice(channelVoiceKey(channel,chatId,thread)); }
  setChannelVoice(channel: string, chatId: string, thread: string, enabled: boolean): void { this.setTelegramVoice(channelVoiceKey(channel,chatId,thread),enabled); }
  channelVoiceMode(channel: string, chatId: string, thread = ''): VoiceReplyMode { return this.telegramVoiceMode(channelVoiceKey(channel,chatId,thread)); }
  setChannelVoiceMode(channel: string, chatId: string, thread: string, mode: VoiceReplyMode): void { this.setTelegramVoiceMode(channelVoiceKey(channel,chatId,thread),mode); }
  telegramVoiceMode(chatId: string): VoiceReplyMode {
    return this.get('SELECT mode FROM voice_reply_modes WHERE chat_id=?', chatId)?.mode as VoiceReplyMode | undefined
      ?? (this.get('SELECT enabled FROM telegram_voice_preferences WHERE chat_id=?', chatId)?.enabled === 1 ? 'on' : 'off');
  }
  telegramVoice(chatId: string): boolean { return this.telegramVoiceMode(chatId) !== 'off'; }
  setTelegramVoice(chatId: string, enabled: boolean): void { this.setTelegramVoiceMode(chatId, enabled ? 'on' : 'off'); }
  setTelegramVoiceMode(chatId: string, mode: VoiceReplyMode): void {
    if (!VOICE_REPLY_MODES.includes(mode)) throw new OrchestrationError('INVALID_VOICE_MODE');
    const write = () => {
      this.run('INSERT INTO voice_reply_modes VALUES(?,?) ON CONFLICT(chat_id) DO UPDATE SET mode=excluded.mode', chatId, mode);
      // Older binaries degrade auto to off, never to always-on audio.
      this.run('INSERT INTO telegram_voice_preferences VALUES(?,?) ON CONFLICT(chat_id) DO UPDATE SET enabled=excluded.enabled', chatId, mode === 'on' ? 1 : 0);
    };
    if (this.inTransaction) write(); else this.transaction(write);
  }
  close(): void { this.db.close(); }
  get(sql: string, ...values: SQLInputValue[]): Row | undefined { return this.db.prepare(sql).get(...values) as Row | undefined; }
  all(sql: string, ...values: SQLInputValue[]): Row[] { return this.db.prepare(sql).all(...values) as Row[]; }
  run(sql: string, ...values: SQLInputValue[]) { return this.db.prepare(sql).run(...values); }
  /** Synchronous only: network, process startup and canonical history writes stay outside. */
  transaction<T>(operation: () => T): T {
    if (this.inTransaction) throw new OrchestrationError('NESTED_TRANSACTION');
    this.db.exec('BEGIN IMMEDIATE'); this.inTransaction = true;
    try {
      const result = operation();
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new OrchestrationError('ASYNC_TRANSACTION');
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.inTransaction = false; }
  }
  assertMember(conversationId: string, principalId: string): Row {
    const row = this.get(`SELECT c.* FROM conversations c JOIN conversation_members m ON c.id=m.conversation_id
      WHERE c.id=? AND c.agent_id=? AND m.principal_id=?`, conversationId, this.agentId, principalId);
    if (!row) throw new OrchestrationError('ACCESS_DENIED');
    return row;
  }
  acceptInput(input: AcceptInput, maxPending = 100): InputReceipt {
    const { scope } = input;
    if (scope.agentId !== this.agentId) throw new OrchestrationError('ACCESS_DENIED');
    if (Buffer.byteLength(JSON.stringify(input)) > 262144) throw new OrchestrationError('PAYLOAD_TOO_LARGE');
    if (input.acceptedInputId) {
      const row = this.get('SELECT * FROM conversation_inputs WHERE id=?', input.acceptedInputId);
      if (!row || row.principal_id !== scope.principalId) throw new OrchestrationError('ACCESS_DENIED');
      const agentSession = this.assertMember(String(row.conversation_id), scope.principalId);
      if (agentSession.agent_session_id !== scope.agentSessionId) throw new OrchestrationError('ACCESS_DENIED');
      return { inputId: String(row.id), conversationId: String(row.conversation_id), bindingId: String(row.binding_id) };
    }
    for (const key of ['agentId', 'agentSessionId', 'principalId', 'chatId'] as const) boundedText(scope[key], 1024);
    boundedText(input.text);
    if (input.attachmentIds && (input.attachmentIds.length > 64 || input.attachmentIds.some(id => typeof id !== 'string' || id.length > 1024))) throw new OrchestrationError('INVALID_INPUT');
    if (!Number.isSafeInteger(maxPending) || maxPending <= 0) throw new OrchestrationError('INVALID_CONFIG');
    // Agent session intentionally excluded: a provider retry after a session
    // switch must retain the original agent binding. Ingress authorizes route.
    const hash = payloadHash({ text: input.text, attachments: input.attachmentIds ?? [], modality: input.modality ?? 'text',
      principal: scope.principalId, source: scope.source, account: scope.accountId, chat: scope.chatId, thread: scope.threadKey,
      storeUserMessage: input.storeUserMessage !== false, metadata: input.metadata, model: input.model });
    const ingressKey = input.ingressKey ? payloadHash([this.agentId, scope.source, scope.accountId, scope.chatId, scope.threadKey, scope.principalId, boundedText(input.ingressKey, 2048)]) : undefined;
    return this.transaction(() => {
      if (ingressKey) {
        const prior = this.get(`SELECT r.*,i.binding_id FROM ingress_receipts r JOIN conversation_inputs i ON i.id=r.input_id WHERE ingress_key=?`, ingressKey);
        if (prior) {
          if (prior.payload_hash !== hash) throw new OrchestrationError('IDEMPOTENCY_CONFLICT');
          this.assertMember(String(prior.conversation_id), scope.principalId);
          return { inputId: String(prior.input_id), conversationId: String(prior.conversation_id), bindingId: String(prior.binding_id) };
        }
      }
      let conversation = this.get(`SELECT * FROM conversations WHERE agent_id=? AND agent_session_id=? AND source=? AND account_id=? AND chat_id=? AND thread_key=?`,
        this.agentId, scope.agentSessionId, scope.source, scope.accountId, scope.chatId, scope.threadKey);
      const canonicalSessions = this.all('SELECT * FROM conversations WHERE agent_id=? AND agent_session_id=?', this.agentId, scope.agentSessionId);
      for (const canonicalSession of canonicalSessions) {
        if (input.trustedChannelMember && scope.source !== 'api' && canonicalSession.source === scope.source && canonicalSession.account_id === scope.accountId && canonicalSession.chat_id === scope.chatId) {
          this.run('INSERT INTO conversation_members VALUES(?,?,?) ON CONFLICT DO NOTHING', canonicalSession.id, scope.principalId, 'member');
        }
        this.assertMember(String(canonicalSession.id), scope.principalId);
      }
      const now = Date.now();
      if (!conversation) {
        const id = randomUUID();
        this.run(`INSERT INTO conversations(id,agent_id,agent_session_id,source,account_id,chat_id,thread_key,owner_principal_id,stream_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          id, this.agentId, scope.agentSessionId, scope.source, scope.accountId, scope.chatId, scope.threadKey, scope.principalId, randomUUID(), now, now);
        this.run('INSERT INTO conversation_members VALUES(?,?,?)', id, scope.principalId, 'owner');
        this.run(`INSERT INTO conversation_bindings VALUES(?,?,?,?,?,?,?,?)`, randomUUID(), id, scope.source, scope.accountId, scope.chatId, scope.threadKey, 'next_user_turn', '{}');
        conversation = this.get('SELECT * FROM conversations WHERE id=?', id)!;
      }
      const id = String(conversation.id);
      this.assertMember(id, scope.principalId);
      // Snapshot the conversation's last selected model for voice and task reports.
      // Do this after authorization, inside the same admission transaction. The
      // retry hash above still describes the submitted payload, not later defaults.
      const previousModel = input.model ? undefined : this.get(`SELECT json_extract(ingress_json,'$.model') AS model
        FROM conversation_inputs WHERE conversation_id=? AND json_type(ingress_json,'$.model')='text'
        AND json_extract(ingress_json,'$.model')<>'' ORDER BY input_seq DESC LIMIT 1`, id)?.model;
      const admittedInput = previousModel ? { ...input, model: String(previousModel) } : input;
      const pending = Number(this.get("SELECT COUNT(*) AS n FROM conversation_inputs WHERE conversation_id=? AND status IN ('accepted','assigned')", id)!.n);
      if (pending >= maxPending) throw new OrchestrationError('QUEUE_FULL');
      const bindingId = String(this.get('SELECT id FROM conversation_bindings WHERE conversation_id=?', id)!.id);
      const inputId = randomUUID(), seq = Number(conversation.last_input_seq) + 1;
      this.run('UPDATE conversations SET last_input_seq=?,updated_at=? WHERE id=?', seq, now, id);
      this.run(`INSERT INTO conversation_inputs(id,conversation_id,input_seq,principal_id,binding_id,modality,text,attachment_refs_json,request_id,store_user_message,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        inputId, id, seq, scope.principalId, bindingId, input.modality ?? 'text', input.text, JSON.stringify(input.attachmentIds ?? []), input.requestId ?? null, input.storeUserMessage === false ? 0 : 1, now);
      this.run('UPDATE conversation_inputs SET ingress_json=? WHERE id=?', JSON.stringify(admittedInput), inputId);
      if (ingressKey) this.run('INSERT INTO ingress_receipts VALUES(?,?,?,?,?)', ingressKey, hash, inputId, id, now);
      this.appendEvent(id, 'input.accepted', { inputId });
      this.enqueue('input', `input:${inputId}`, { conversationId: id, inputId });
      // Live voice arrives as finalized text. Uploaded voice notes still need STT
      // before their canonical history operation can be written.
      if (input.modality === 'live_voice') {
        this.run('INSERT INTO history_operations VALUES(?,?,?,?,?,?,?,?)', `input:${inputId}`, id, inputId, null, 'append', null, 'pending', now);
        this.enqueue('history', `input:${inputId}`, { operationId: `input:${inputId}` });
      }
      return { inputId, conversationId: id, bindingId };
    });
  }
  appendEvent(conversationId: string, type: string, payload: unknown, taskId?: string): OrchestrationEvent {
    if (!this.inTransaction) throw new OrchestrationError('TRANSACTION_REQUIRED');
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized) > 65536) throw new OrchestrationError('PAYLOAD_TOO_LARGE');
    const row = this.get('UPDATE conversations SET last_event_seq=last_event_seq+1 WHERE id=? RETURNING stream_id,last_event_seq', conversationId);
    if (!row) throw new OrchestrationError('CONVERSATION_NOT_FOUND');
    const event: OrchestrationEvent = { schema_version: 1, event_id: randomUUID(), conversation_id: conversationId,
      stream_id: String(row.stream_id), seq: Number(row.last_event_seq), type, occurred_at: Date.now(), ...(taskId ? { task_id: taskId } : {}), payload };
    this.run('INSERT INTO conversation_events VALUES(?,?,?,?,?,?)', conversationId, event.seq, event.event_id, type, JSON.stringify(event), event.occurred_at);
    return event;
  }
  enqueue(kind: string, dedupKey: string, payload: unknown): void {
    if (!this.inTransaction) throw new OrchestrationError('TRANSACTION_REQUIRED');
    const now = Date.now();
    this.run('INSERT INTO outbox(id,kind,dedup_key,payload_json,available_at,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(dedup_key) DO NOTHING', randomUUID(), kind, dedupKey, JSON.stringify(payload), now, now);
  }
  task(id: string): TaskSnapshot | undefined {
    const row = this.get('SELECT snapshot_json FROM tasks WHERE id=?', id);
    return row ? JSON.parse(String(row.snapshot_json)) : undefined;
  }
  attempt(id: string): TaskAttempt | undefined {
    const row = this.get('SELECT payload_json FROM task_attempts WHERE id=?', id);
    return row ? JSON.parse(String(row.payload_json)) : undefined;
  }
  saveTask(task: TaskSnapshot, expectedVersion: number): void {
    if (!this.inTransaction) throw new OrchestrationError('TRANSACTION_REQUIRED');
    task.stateVersion = expectedVersion + 1; task.updatedAt = Date.now();
    const changed = this.run(`UPDATE tasks SET state=?,state_version=?,revision=?,active_attempt_id=?,snapshot_json=?,updated_at=? WHERE id=? AND state_version=?`,
      task.state, task.stateVersion, task.revision, task.activeAttemptId ?? null, JSON.stringify(task), task.updatedAt, task.taskId, expectedVersion);
    if (Number(changed.changes) !== 1) throw new OrchestrationError('STATE_CONFLICT');
    this.appendEvent(task.conversationId, 'task.state_changed', task, task.taskId);
  }
  saveAttempt(attempt: TaskAttempt): void {
    if (!this.inTransaction) throw new OrchestrationError('TRANSACTION_REQUIRED');
    this.run('UPDATE task_attempts SET state=?,payload_json=? WHERE id=? AND generation=?', attempt.state, JSON.stringify(attempt), attempt.attemptId, attempt.generation);
  }
}

/** Preserve existing Telegram preferences while namespacing all other channels. */
export function channelVoiceKey(channel: string, chatId: string, thread = ''): string { return channel==='telegram'?chatId:JSON.stringify([channel,chatId]); }
