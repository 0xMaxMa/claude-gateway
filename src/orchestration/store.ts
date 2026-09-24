import {syncAutomationSession} from './tasks/automation-session';
import { advanceTiming } from './tasks/timing';
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
  /** Trusted API ingress fingerprint, before file preparation or saved defaults. */
  requestFingerprint?: string;
  storeUserMessage?: boolean;
  /** Stable provider/client identifier, scoped by trusted ingress before use. */
  ingressKey?: string;
  /** Only ingress supplies these; they survive a crash before agent admission. */
  capabilities?: ExecutionCapabilities;
  model?: string;
  metadata?: { executionTaskId?: string; clientMessageId?: string; channelIngressFingerprint?: string; recoveryBatch?: string; recoveredChannelInput?: {content:string;meta:Record<string,string>};
    unavailableAttachments?: Array<{code:string;name?:string;quoted:boolean}>; senderName?: string; senderId?: string; platformMessageId?: string; platformMessageIds?: string[]; mediaGroupId?: string; promptContext?: string; imageRefs?: string[];
    attachmentName?: string; mediaType?: string; repliedText?: string; repliedMessageId?: string; repliedSender?: string; repliedAttachmentIds?: string[]; attachmentDetails?: Array<{ref:string;name?:string;quoted:boolean}>; attachmentError?: string };
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
  private composing = false;
  private savepointSequence = 0;
  constructor(readonly filename: string, readonly agentId: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    try {
      if (filename !== ':memory:') chmodSync(filename, 0o600);
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.transaction(() => {
        this.db.exec('CREATE TABLE IF NOT EXISTS orchestration_schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
        this.db.exec(`CREATE TABLE IF NOT EXISTS provider_waits (
          entity_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, scope TEXT NOT NULL,
          waiting_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS provider_notices (
          conversation_id TEXT NOT NULL, scope TEXT NOT NULL, episode TEXT NOT NULL, recovered INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(conversation_id,scope));`);
        this.db.exec(`CREATE TABLE IF NOT EXISTS provider_task_routes (
          task_id TEXT PRIMARY KEY, configured_scope TEXT NOT NULL, actual_scope TEXT NOT NULL);`);
        const version = this.get('SELECT MAX(version) AS version FROM orchestration_schema_migrations')?.version ?? 0;
        if (Number(version) > 1) throw new OrchestrationError('UNSUPPORTED_SCHEMA');
        if (!version) {
          this.db.exec(ORCHESTRATION_SCHEMA_V1);
          this.run('INSERT INTO orchestration_schema_migrations VALUES(1,?)', Date.now());
        }
        this.db.exec(`CREATE TABLE IF NOT EXISTS task_questions(
          question_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL, state_version INTEGER NOT NULL,
          binding_id TEXT NOT NULL REFERENCES conversation_bindings(id), next_reminder_at INTEGER NOT NULL,
          reminder_count INTEGER NOT NULL DEFAULT 0, muted INTEGER NOT NULL DEFAULT 0, closed INTEGER NOT NULL DEFAULT 0);
          CREATE INDEX IF NOT EXISTS task_questions_task ON task_questions(task_id,closed);
          CREATE TABLE IF NOT EXISTS task_question_messages(
          response_id TEXT NOT NULL REFERENCES assistant_responses(id), question_id TEXT NOT NULL REFERENCES task_questions(question_id), PRIMARY KEY(response_id,question_id));
          CREATE INDEX IF NOT EXISTS task_question_messages_question ON task_question_messages(question_id);
          CREATE INDEX IF NOT EXISTS deliveries_provider_message ON deliveries(provider_message_id,binding_id);
          CREATE INDEX IF NOT EXISTS conversation_events_task_tool ON conversation_events(json_extract(payload_json,'$.task_id'),seq DESC) WHERE type='tool.activity';`);
        // Existing installations mapped one question per message. Natural reminders
        // can combine several questions without losing their reply associations.
        if (!Number(this.all('PRAGMA table_info(task_question_messages)').find(row => row.name === 'question_id')?.pk)) {
          this.db.exec(`ALTER TABLE task_question_messages RENAME TO task_question_messages_old;
            CREATE TABLE task_question_messages(response_id TEXT NOT NULL REFERENCES assistant_responses(id),
              question_id TEXT NOT NULL REFERENCES task_questions(question_id), PRIMARY KEY(response_id,question_id));
            INSERT INTO task_question_messages SELECT * FROM task_question_messages_old;
            DROP TABLE task_question_messages_old;
            CREATE INDEX task_question_messages_question ON task_question_messages(question_id);`);
        }
        this.db.exec(`CREATE TABLE IF NOT EXISTS task_question_attention(
          question_id TEXT PRIMARY KEY REFERENCES task_questions(question_id),
          last_discussed_at INTEGER NOT NULL DEFAULT 0, last_review_at INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS task_question_prompts(
          id TEXT PRIMARY KEY, decision_id TEXT NOT NULL REFERENCES conversation_decisions(id),
          conversation_id TEXT NOT NULL REFERENCES conversations(id), binding_id TEXT NOT NULL REFERENCES conversation_bindings(id),
          question_ids_json TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending');`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS conversations_session ON conversations(agent_session_id);
          CREATE INDEX IF NOT EXISTS response_voice_resume ON assistant_responses(conversation_id,created_at,id) WHERE state='completed';
          CREATE INDEX IF NOT EXISTS delivery_voice_resume ON deliveries(response_id,state) WHERE modality='audio';`);
        this.db.exec('CREATE TABLE IF NOT EXISTS browser_voice(session_id TEXT NOT NULL, principal_id TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), since INTEGER NOT NULL, PRIMARY KEY(session_id,principal_id))');
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
  replaySpeech(sessionId: string, responseId: string): string | undefined {
    const row = this.get(`SELECT s.text FROM response_speech s JOIN assistant_responses r ON r.id=s.response_id
      JOIN conversations c ON c.id=r.conversation_id WHERE c.agent_session_id=? AND r.id=? AND r.state='completed'`, sessionId, responseId);
    return row?.text ? String(row.text) : undefined;
  }
  replayableResponses(sessionId: string): string[] {
    return this.all(`SELECT r.id FROM assistant_responses r JOIN conversations c ON c.id=r.conversation_id
      WHERE c.agent_session_id=? AND (EXISTS(SELECT 1 FROM response_audio a WHERE a.response_id=r.id AND a.created_at>?)
      OR (r.state='completed' AND EXISTS(SELECT 1 FROM response_speech s WHERE s.response_id=r.id AND length(trim(s.text))>0)))`,
      sessionId, Date.now()-30*86400000).map(r => String(r.id));
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
    if (this.inTransaction) {
      if (!this.composing) throw new OrchestrationError('NESTED_TRANSACTION');
      const name = `composed_${++this.savepointSequence}`;
      this.db.exec(`SAVEPOINT ${name}`);
      try {
        const result = operation();
        if (result && typeof (result as { then?: unknown }).then === 'function') throw new OrchestrationError('ASYNC_TRANSACTION');
        this.db.exec(`RELEASE SAVEPOINT ${name}`); return result;
      } catch (error) { this.db.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`); throw error; }
    }
    this.db.exec('BEGIN IMMEDIATE'); this.inTransaction = true;
    try {
      const result = operation();
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new OrchestrationError('ASYNC_TRANSACTION');
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.inTransaction = false; }
  }
  /** Explicit atomic composition of existing synchronous commands. Each nested
   * command rolls back to its own savepoint even if the caller handles its error. */
  compose<T>(operation: () => T): T {
    const previous = this.composing;
    this.composing = true;
    try { return this.transaction(operation); } finally { this.composing = previous; }
  }
  assertMember(conversationId: string, principalId: string): Row {
    const row = this.get(`SELECT c.* FROM conversations c JOIN conversation_members m ON c.id=m.conversation_id
      WHERE c.id=? AND c.agent_id=? AND m.principal_id=?`, conversationId, this.agentId, principalId);
    if (!row) throw new OrchestrationError('ACCESS_DENIED');
    return row;
  }
  private ingressReceipt(scope: ConversationScope, ingressKey: string | undefined): Row | undefined {
    if (!ingressKey) return undefined;
    if (scope.agentId !== this.agentId) throw new OrchestrationError('ACCESS_DENIED');
    const key = payloadHash([this.agentId, scope.source, scope.accountId, scope.chatId, scope.threadKey, scope.principalId, boundedText(ingressKey, 2048)]);
    const prior = this.get(`SELECT r.input_id,r.conversation_id,i.binding_id,i.ingress_json FROM ingress_receipts r
      JOIN conversation_inputs i ON i.id=r.input_id WHERE r.ingress_key=?`, key);
    if (prior) this.assertMember(String(prior.conversation_id), scope.principalId);
    return prior;
  }
  /** Resolve an API retry before touching uploads or mutable session defaults. */
  apiReceipt(scope: ConversationScope, ingressKey: string | undefined, fingerprint: string): InputReceipt | undefined {
    if (scope.source !== 'api') throw new OrchestrationError('ACCESS_DENIED');
    const prior = this.ingressReceipt(scope, ingressKey);
    if (!prior) return undefined;
    const input = JSON.parse(String(prior.ingress_json)) as AcceptInput;
    if (input.scope.agentSessionId !== scope.agentSessionId) throw new OrchestrationError('ACCESS_DENIED');
    if (input.requestFingerprint !== fingerprint) throw new OrchestrationError('IDEMPOTENCY_CONFLICT');
    return { inputId: String(prior.input_id), conversationId: String(prior.conversation_id), bindingId: String(prior.binding_id) };
  }
  /** A lost receiver ACK must not re-fetch an expired file or re-admit work. */
  channelReceipt(scope: ConversationScope, ingressKey: string | undefined, fingerprint: string, platformMessageIds?: string[]): (InputReceipt & {envelopeConflict:boolean}) | undefined {
    const prior = this.ingressReceipt(scope, ingressKey);
    if (!prior) return undefined;
    const metadata = JSON.parse(String(prior.ingress_json)).metadata;
    const original = metadata?.channelIngressFingerprint;
    const originalIds = Array.isArray(metadata?.platformMessageIds) ? metadata.platformMessageIds : [ingressKey];
    // Legacy albums could expand after admission while their ACK was in flight.
    // Preserve an expanded envelope separately; its first ID cannot ACK new members.
    const envelopeConflict = original ? original !== fingerprint
      : Array.isArray(platformMessageIds) && platformMessageIds.some(id=>!originalIds.includes(id));
    return {inputId:String(prior.input_id),conversationId:String(prior.conversation_id),bindingId:String(prior.binding_id),envelopeConflict};
  }
  /** Complete a deterministic ingress receipt without scheduling inference. */
  completeInputReceipt(receipt: InputReceipt): void {
    this.run("UPDATE conversation_inputs SET status='handled' WHERE id=?", receipt.inputId);
    this.run("UPDATE outbox SET state='completed' WHERE kind='input' AND dedup_key=?", `input:${receipt.inputId}`);
    this.run('INSERT OR IGNORE INTO history_operations VALUES(?,?,?,?,?,?,?,?)', `input:${receipt.inputId}`, receipt.conversationId, receipt.inputId, null, 'append', null, 'pending', Date.now());
    this.enqueue('history', `input:${receipt.inputId}`, {operationId:`input:${receipt.inputId}`});
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
    const hash = scope.source === 'api' && input.requestFingerprint
      ? boundedText(input.requestFingerprint, 64)
      : payloadHash({ text: input.text, attachments: input.attachmentIds ?? [], modality: input.modality ?? 'text',
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
      // Text is already canonical at admission, even while another response runs.
      // Uploaded voice notes still need STT before projecting their transcript.
      if (input.modality !== 'voice_note') {
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
    if (!row) return;
    const task: TaskSnapshot = JSON.parse(String(row.snapshot_json));
    delete task.providerWaiting;
    if (task.state === 'queued') {
      const waiting = this.get('SELECT waiting_json FROM provider_waits WHERE entity_id=?', id);
      if (waiting) task.providerWaiting = JSON.parse(String(waiting.waiting_json));
    }
    return task;
  }
  attempt(id: string): TaskAttempt | undefined {
    const row = this.get('SELECT payload_json FROM task_attempts WHERE id=?', id);
    return row ? JSON.parse(String(row.payload_json)) : undefined;
  }
  cancelQuestionDeliveries(questionId: string): void {
    if (!this.inTransaction) throw new OrchestrationError('TRANSACTION_REQUIRED');
    // Cancelling an undelivered combined first question must not strand its
    // other questions as "already asked". Wake the agent to rephrase those.
    const peers = this.all(`SELECT DISTINCT q.question_id FROM task_question_messages other
      JOIN task_questions q ON q.question_id=other.question_id
      JOIN deliveries d ON d.response_id=other.response_id
      WHERE q.question_id!=? AND q.closed=0 AND q.reminder_count=1 AND d.state='pending'
      AND other.response_id IN (SELECT response_id FROM task_question_messages WHERE question_id=?)
      AND NOT EXISTS(SELECT 1 FROM deliveries sent JOIN task_question_messages m ON m.response_id=sent.response_id
        WHERE m.question_id=q.question_id AND sent.state='delivered')`, questionId, questionId);
    for (const peer of peers) {
      this.run('UPDATE task_questions SET reminder_count=0,next_reminder_at=0 WHERE question_id=?', peer.question_id);
      this.run('UPDATE task_question_attention SET last_review_at=0 WHERE question_id=?', peer.question_id);
    }
    this.run(`UPDATE outbox SET state='completed' WHERE kind='delivery' AND state='pending'
      AND json_extract(payload_json,'$.deliveryId') IN (SELECT d.id FROM deliveries d JOIN task_question_messages m ON m.response_id=d.response_id WHERE m.question_id=?)`, questionId);
    this.run(`UPDATE deliveries SET state='failed' WHERE state='pending' AND response_id IN
      (SELECT response_id FROM task_question_messages WHERE question_id=?)`, questionId);
  }
  saveTask(task: TaskSnapshot, expectedVersion: number): void {
    if (!this.inTransaction) throw new OrchestrationError('TRANSACTION_REQUIRED');
    delete task.providerWaiting;
    if (task.state !== 'queued') this.run('DELETE FROM provider_waits WHERE entity_id=?', task.taskId);
    syncAutomationSession(task);
    advanceTiming(task);
    task.stateVersion = expectedVersion + 1; task.updatedAt = Date.now();
    const changed = this.run(`UPDATE tasks SET state=?,state_version=?,revision=?,active_attempt_id=?,snapshot_json=?,updated_at=? WHERE id=? AND state_version=?`,
      task.state, task.stateVersion, task.revision, task.activeAttemptId ?? null, JSON.stringify(task), task.updatedAt, task.taskId, expectedVersion);
    if (Number(changed.changes) !== 1) throw new OrchestrationError('STATE_CONFLICT');
    for (const question of this.all(`UPDATE task_questions SET closed=1 WHERE task_id=? AND closed=0
      AND question_id!=? RETURNING question_id,state_version`, task.taskId, task.state === 'waiting_input' ? task.pendingQuestion?.questionId ?? '' : '')) {
      this.cancelQuestionDeliveries(String(question.question_id));
      this.run("UPDATE notifications SET status='handled' WHERE task_id=? AND task_state_version<=? AND status='pending'", task.taskId, question.state_version);
    }
    // State events are notifications, not the result store. Large results remain
    // complete in the snapshot/attempt and are retrieved through task_status.
    const eventTask = task.result && Buffer.byteLength(JSON.stringify(task)) > 65536
      ? { ...task, result: undefined, resultAvailable: true, resultRef: { tool: 'task_status', task_id: task.taskId } }
      : task;
    this.appendEvent(task.conversationId, 'task.state_changed', eventTask, task.taskId);
  }
  saveAttempt(attempt: TaskAttempt): void {
    if (!this.inTransaction) throw new OrchestrationError('TRANSACTION_REQUIRED');
    this.run('UPDATE task_attempts SET state=?,payload_json=? WHERE id=? AND generation=?', attempt.state, JSON.stringify(attempt), attempt.attemptId, attempt.generation);
  }
}

/** Preserve existing Telegram preferences while namespacing all other channels. */
export function channelVoiceKey(channel: string, chatId: string, thread = ''): string { return channel==='telegram'?chatId:JSON.stringify([channel,chatId]); }
