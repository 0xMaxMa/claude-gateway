import { randomUUID } from 'crypto';
import { OrchestrationStore } from './store';
import { OrchestrationError } from './types';

export interface DecisionReceipt { decisionId: string; epoch: number; inputIds: string[]; requestId?: string; responseId?: string; }
export class DecisionService {
  constructor(readonly store: OrchestrationStore, private readonly deliver?: (responseId: string, bindingId: string, text: string) => void) {}
  /** Deterministic system notice: no inference, input consumption, or epoch change. */
  notice(conversationId: string, text: string, deliver: boolean): string {
    return this.store.transaction(() => {
      const conversation = this.store.get("SELECT * FROM conversations WHERE id=? AND status='active'", conversationId);
      if (!conversation) throw new OrchestrationError('CONVERSATION_NOT_FOUND');
      const id = randomUUID(), responseId = randomUUID(), now = Date.now();
      this.store.run('INSERT INTO conversation_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?)', id, conversationId, conversation.epoch, 'notice', null, 'completed', conversation.agent_session_id, '[]', '[]', now, now);
      this.store.run('INSERT INTO assistant_responses VALUES(?,?,?,?,?,?,?,?)', responseId, conversationId, id, null, 'completed', text, now, now);
      this.historyOperation(`response:${responseId}`, conversationId, null, responseId);
      const binding = this.store.get('SELECT * FROM conversation_bindings WHERE conversation_id=? AND channel=? AND chat_id=? AND thread_key=?', conversationId, conversation.source, conversation.chat_id, conversation.thread_key);
      if (deliver && binding && binding.channel !== 'api') this.deliver?.(responseId, String(binding.id), text);
      this.store.appendEvent(conversationId, 'response.completed', { responseId });
      return responseId;
    });
  }
  begin(conversationId: string, principalId: string, inputIds: string[], requestId?: string): DecisionReceipt {
    if (!inputIds.length || inputIds.length > 100 || new Set(inputIds).size !== inputIds.length) throw new OrchestrationError('INVALID_INPUT');
    return this.store.transaction(() => {
      const conversation = this.store.assertMember(conversationId, principalId);
      if (this.store.get("SELECT id FROM conversation_decisions WHERE conversation_id=? AND state IN ('running','interrupting')", conversationId)) throw new OrchestrationError('AGENT_BUSY');
      for (const inputId of inputIds) {
        const input = this.store.get('SELECT * FROM conversation_inputs WHERE id=? AND conversation_id=? AND principal_id=?', inputId, conversationId, principalId);
        if (!input || input.status !== 'accepted' || (input.request_id ?? undefined) !== requestId) throw new OrchestrationError('INPUT_CONFLICT');
      }
      const decisionId = randomUUID(), epoch = Number(conversation.epoch) + 1;
      this.store.run('UPDATE conversations SET epoch=? WHERE id=?', epoch, conversationId);
      const notifications = this.store.all("SELECT id FROM notifications WHERE conversation_id=? AND status='pending' LIMIT 100", conversationId).map(row => String(row.id));
      this.store.run('INSERT INTO conversation_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?)', decisionId, conversationId, epoch, 'user', requestId ?? null,
        'running', conversation.agent_session_id, JSON.stringify(inputIds), JSON.stringify(notifications), Date.now(), null);
      const responseId = randomUUID();
      this.store.run('INSERT INTO assistant_responses VALUES(?,?,?,?,?,?,?,?)', responseId, conversationId, decisionId, requestId ?? null, 'generating', '', Date.now(), null);
      for (const inputId of inputIds) {
        this.store.run("UPDATE conversation_inputs SET status='assigned' WHERE id=?", inputId);
        this.store.run("UPDATE outbox SET state='completed' WHERE dedup_key=? AND kind='input'", `input:${inputId}`);
      }
      for (const id of notifications) this.store.run("UPDATE notifications SET status='assigned',decision_id=? WHERE id=?", decisionId, id);
      return { decisionId, epoch, inputIds, requestId, responseId };
    });
  }
  /** Explicit stop controls acknowledge cancellation themselves; retain history without redelivering. */
  finish(receipt: DecisionReceipt, text: string, state: 'completed' | 'interrupted' | 'failed' = 'completed', spoken?: string, deliver = true): string {
    if (Buffer.byteLength(text) > 262144) throw new OrchestrationError('PAYLOAD_TOO_LARGE');
    return this.store.transaction(() => {
      const decision = this.store.get(`SELECT d.* FROM conversation_decisions d JOIN conversations c ON c.id=d.conversation_id
        WHERE d.id=? AND d.epoch=? AND ((d.epoch=c.epoch AND d.state='running') OR (d.epoch+1=c.epoch AND d.state='interrupting' AND ?='interrupted'))`, receipt.decisionId, receipt.epoch, state);
      if (!decision) throw new OrchestrationError('STALE_DECISION');
      const now = Date.now(), responseId = String(this.store.get('SELECT id FROM assistant_responses WHERE decision_id=?', receipt.decisionId)!.id);
      this.store.run('UPDATE assistant_responses SET state=?,generated_text=?,completed_at=? WHERE id=?', state, text, now, responseId);
      this.store.run('UPDATE conversation_decisions SET state=?,ended_at=? WHERE id=?', state, now, receipt.decisionId);
      for (const id of JSON.parse(String(decision.input_ids_json)) as string[]) {
        this.store.run("UPDATE conversation_inputs SET status='handled' WHERE id=?", id);
        this.historyOperation(`input:${id}`, String(decision.conversation_id), id, null);
      }
      this.historyOperation(`response:${responseId}`, String(decision.conversation_id), null, responseId);
      if (state === 'completed') this.store.run(`UPDATE task_files SET response_id=? WHERE response_id IS NULL AND task_id IN
        (SELECT n.task_id FROM notifications n JOIN tasks t ON t.id=n.task_id WHERE n.decision_id=? AND t.state='completed')
        AND id IN (SELECT j.value FROM tasks t,json_each(t.snapshot_json,'$.result.artifactIds') j WHERE t.id=task_files.task_id)`, responseId, receipt.decisionId);
      if (state === 'completed' && spoken) this.store.run('INSERT INTO response_speech VALUES(?,?) ON CONFLICT(response_id) DO UPDATE SET text=excluded.text', responseId, spoken);
      const firstInput = this.store.get('SELECT binding_id FROM conversation_inputs WHERE id=?', receipt.inputIds[0]);
      const binding = firstInput && this.store.get('SELECT channel FROM conversation_bindings WHERE id=?', firstInput.binding_id);
      if (deliver && binding && binding.channel !== 'api') this.deliver?.(responseId, String(firstInput!.binding_id), text);
      if (state === 'completed') this.store.run("UPDATE notifications SET status='handled' WHERE decision_id=? AND status='assigned'", receipt.decisionId);
      else this.store.run("UPDATE notifications SET status='pending',decision_id=NULL WHERE decision_id=? AND status='assigned'", receipt.decisionId);
      for (const id of state === 'completed' ? JSON.parse(String(decision.notification_ids_json)) as string[] : []) {
        this.store.run("UPDATE outbox SET state='completed' WHERE kind='notification' AND json_extract(payload_json,'$.notificationId')=?", id);
      }
      this.store.appendEvent(String(decision.conversation_id), `response.${state}`, { responseId });
      return responseId;
    });
  }
  /** Invalidate commands before asking the driver to stop. Caller must wait for
   * its true terminal/exit acknowledgment before releaseInterrupted. */
  interrupt(receipt: DecisionReceipt): void {
    this.store.transaction(() => {
      const row = this.store.get("UPDATE conversation_decisions SET state='interrupting' WHERE id=? AND epoch=? AND state='running' RETURNING conversation_id", receipt.decisionId, receipt.epoch);
      if (!row) throw new OrchestrationError('STALE_DECISION');
      this.store.run('UPDATE conversations SET epoch=epoch+1 WHERE id=? AND epoch=?', row.conversation_id, receipt.epoch);
    });
  }
  releaseInterrupted(receipt: DecisionReceipt, explicitStop: boolean): void {
    this.store.transaction(() => {
      const row = this.store.get("SELECT * FROM conversation_decisions WHERE id=? AND epoch=? AND state='interrupting'", receipt.decisionId, receipt.epoch);
      if (!row) throw new OrchestrationError('STALE_DECISION');
      this.store.run("UPDATE conversation_decisions SET state='interrupted',ended_at=? WHERE id=?", Date.now(), receipt.decisionId);
      for (const id of JSON.parse(String(row.input_ids_json)) as string[]) this.store.run('UPDATE conversation_inputs SET status=? WHERE id=?', explicitStop ? 'handled' : 'accepted', id);
      this.store.run("UPDATE notifications SET status='pending',decision_id=NULL WHERE decision_id=? AND status='assigned'", receipt.decisionId);
    });
  }
  private historyOperation(operationId: string, conversationId: string, inputId: string | null, responseId: string | null): void {
    this.store.run('INSERT INTO history_operations VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO NOTHING', operationId, conversationId, inputId, responseId, 'append', null, 'pending', Date.now());
    this.store.enqueue('history', operationId, { operationId });
  }
}
