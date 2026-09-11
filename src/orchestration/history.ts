import { SessionStore } from '../session/store';
import { HistoryDB } from '../history/db';
import { ChatChannelOrApi } from '../history/types';
import { OrchestrationStore } from './store';
import { OrchestrationError } from './types';

/** Sidecar and canonical history cannot share a transaction. Each canonical
 * writer deduplicates the same operation ID before the sidecar marks it done. */
export class OrchestrationHistoryWriter {
  constructor(private readonly orchestration: OrchestrationStore, private readonly sessions: SessionStore, private readonly history: HistoryDB) {}
  async write(operationId: string): Promise<void> {
    const operation = this.orchestration.get('SELECT * FROM history_operations WHERE operation_id=?', operationId);
    if (!operation) throw new OrchestrationError('HISTORY_OPERATION_NOT_FOUND');
    if (operation.state === 'completed') return;
    const conversation = this.orchestration.get('SELECT * FROM conversations WHERE id=?', operation.conversation_id)!;
    const input = operation.input_id ? this.orchestration.get('SELECT * FROM conversation_inputs WHERE id=?', operation.input_id) : undefined;
    const response = operation.response_id ? this.orchestration.get('SELECT * FROM assistant_responses WHERE id=?', operation.response_id) : undefined;
    if (!input && !response) throw new OrchestrationError('HISTORY_MESSAGE_NOT_FOUND');
    if (input?.store_user_message === 0) {
      this.orchestration.run("UPDATE history_operations SET state='completed',updated_at=? WHERE operation_id=?", Date.now(), operationId);
      this.orchestration.run("UPDATE outbox SET state='completed' WHERE kind='history' AND dedup_key=?", operationId);
      return;
    }
    const source = String(conversation.source) as ChatChannelOrApi;
    const sessionId = String(conversation.agent_session_id), chatId = String(conversation.chat_id);
    const message = { operationId, role: input ? 'user' as const : 'assistant' as const,
      content: String(input?.text ?? response?.generated_text), ts: Number(input?.created_at ?? response?.created_at) };
    if (source === 'api') await this.sessions.appendMessage(this.orchestration.agentId, sessionId, message);
    else await this.sessions.appendTelegramMessage(this.orchestration.agentId, chatId, sessionId, message, source);
    const ingress = input ? JSON.parse(String(input.ingress_json ?? '{}')) : {};
    const mediaFiles: string[] = input ? JSON.parse(String(input.attachment_refs_json)) : this.orchestration.all('SELECT path FROM task_files WHERE response_id=? ORDER BY created_at,id', response!.id).map(row => String(row.path));
    const ref = this.history.insertMessageOnce(operationId, { ...message, ...ingress.metadata, mediaFiles: mediaFiles.length ? mediaFiles : undefined, chatId: `${source}-${chatId}`, sessionId, source });
    this.orchestration.run("UPDATE history_operations SET state='completed',canonical_message_ref=?,updated_at=? WHERE operation_id=?", String(ref), Date.now(), operationId);
    this.orchestration.run("UPDATE outbox SET state='completed' WHERE kind='history' AND dedup_key=?", operationId);
  }
}
