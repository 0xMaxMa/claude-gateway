import { OrchestrationStore, boundedText } from './store';
import { CommandContext, OrchestrationError } from './types';

export interface IntakeChoice {
  mode: 'ready' | 'wait' | 'update';
  acknowledgement?: string;
  preparation?: string;
  clarification?: string;
  task_id?: string;
}
export const INTAKE_OVERLAY = `Use conversation_intake only for executable work, incomplete materials, or amendments to an existing task. Greetings, introductions, casual conversation and questions you can answer directly need one normal answer: do not call conversation_intake or emit a separate acknowledgement for them.
Before any work mutation, use conversation_intake to decide how to handle the user's latest input together with pending materials and current tasks.
ready: the requested executable action and required material are complete. Supply a brief, specific acknowledgement addressed directly to the user, in their language and your existing persona. This text is immediately displayed and spoken to the user; it is not a private classification, instruction to yourself, or reasoning field. Do not add a waiting period.
wait: the user is supplying materials without an action, promises an attachment that has not arrived, or says the instruction will follow. Inspect available images now. Preserve useful facts in preparation, clearly distinguishing observed contents from instructions. Supply one short clarification to ask only if no further input arrives for the configured intake wait interval. Do not speculate about unavailable link contents. End this turn without user-facing text; the gateway owns the waiting timer. Each new item will be read as it arrives.
update: the user changes or supplements a specific existing task. Supply its exact task_id and acknowledge the change; use task_update/task_answer, not an independent duplicate. If the target is ambiguous, ask a precise question instead of guessing.
Never create work merely to acknowledge material. A complete instruction arriving after materials is ready now; do not request another waiting interval. Preserve all unchanged requirements and refer to the original input/attachment IDs. Urgent stop or prohibition may call task_cancel before acknowledgement; do not delay fencing unsafe work for speech playback.`;

/** Durable preparation is scoped by conversation AND authenticated principal.
 * Source inputs remain canonical; this cache only supplements their full contents. */
export class ConversationIntake {
  constructor(private store: OrchestrationStore) {
    store.run(`CREATE TABLE IF NOT EXISTS conversation_intake (
      conversation_id TEXT NOT NULL REFERENCES conversations(id), principal_id TEXT NOT NULL,
      binding_id TEXT NOT NULL, mode TEXT NOT NULL, data_json TEXT NOT NULL,
      latest_input_seq INTEGER NOT NULL, last_received_at INTEGER NOT NULL,
      clarified_seq INTEGER, decision_id TEXT NOT NULL,
      PRIMARY KEY(conversation_id,principal_id))`);
  }
  context(conversationId: string, principalId: string, bindingId?: string) {
    this.store.assertMember(conversationId, principalId);
    const row = this.store.get('SELECT * FROM conversation_intake WHERE conversation_id=? AND principal_id=?', conversationId, principalId);
    if (row && bindingId !== undefined && row.binding_id !== bindingId) return undefined;
    return row ? { ...JSON.parse(String(row.data_json)), mode: row.mode, latestInputSeq: row.latest_input_seq } : undefined;
  }
  touch(inputId: string): void {
    const input = this.store.get('SELECT * FROM conversation_inputs WHERE id=?', inputId);
    if (!input || !input.store_user_message) return;
    this.store.run(`UPDATE conversation_intake SET latest_input_seq=?,last_received_at=?
      WHERE conversation_id=? AND principal_id=? AND binding_id=? AND latest_input_seq<?`,
    input.input_seq, input.created_at, input.conversation_id, input.principal_id, input.binding_id, input.input_seq);
  }
  /** A direct answer can consume preparation from an older decision. Never
   * discard newer material or another binding's pending context. */
  consume(inputId: string): void {
    const input = this.store.get('SELECT * FROM conversation_inputs WHERE id=?', inputId);
    if (!input) throw new OrchestrationError('INPUT_NOT_FOUND');
    this.store.run(`DELETE FROM conversation_intake WHERE conversation_id=? AND principal_id=?
      AND binding_id=? AND latest_input_seq<=?`, input.conversation_id, input.principal_id, input.binding_id, input.input_seq);
  }
  choose(context: CommandContext, choice: IntakeChoice) {
    this.store.assertMember(context.conversationId, context.principalId);
    const decision = this.store.get("SELECT * FROM conversation_decisions WHERE id=? AND conversation_id=? AND epoch=? AND state='running'", context.decisionId, context.conversationId, context.epoch);
    const input = this.store.get('SELECT * FROM conversation_inputs WHERE id=? AND conversation_id=? AND principal_id=?', context.inputId, context.conversationId, context.principalId);
    if (!decision || !input) throw new OrchestrationError('STALE_DECISION');
    if (!['ready','wait','update'].includes(choice.mode)) throw new OrchestrationError('INVALID_INPUT');
    const acknowledgement = choice.mode !== 'wait' ? boundedText(choice.acknowledgement ?? '', 600) : '';
    const clarification = choice.mode === 'wait' ? boundedText(choice.clarification ?? '', 600) : '';
    if ((choice.mode !== 'wait' && !acknowledgement.trim()) || (choice.mode === 'wait' && !clarification.trim())) throw new OrchestrationError('INTAKE_MESSAGE_REQUIRED');
    const preparation = choice.preparation?.trim() ? boundedText(choice.preparation, 12000) : ''; 
    if (choice.mode === 'update') {
      const task = choice.task_id && this.store.task(choice.task_id);
      if (!task || task.conversationId !== context.conversationId || ['completed','failed','cancelled'].includes(task.state)) throw new OrchestrationError('INTAKE_TASK_UNAVAILABLE');
    }
    if (choice.mode === 'wait' && this.store.get("SELECT action_id FROM task_commands WHERE decision_id=? AND command_type IN ('spawn','update','answer')", context.decisionId)) throw new OrchestrationError('INTAKE_AFTER_EXECUTION');
    const previousRow = this.store.get('SELECT binding_id,data_json FROM conversation_intake WHERE conversation_id=? AND principal_id=?', context.conversationId, context.principalId);
    const previous = previousRow?.binding_id === input.binding_id ? JSON.parse(String(previousRow.data_json)) : undefined;
    const inputIds: string[] = [...new Set([...(previous?.inputIds ?? []), context.inputId])];
    if (inputIds.length > 100) throw new OrchestrationError('INTAKE_TOO_MANY_INPUTS');
    const data = { ...choice, acknowledgement, clarification, preparation, inputIds, preparedInputSeq: input.input_seq };
    this.store.run(`INSERT INTO conversation_intake (conversation_id,principal_id,binding_id,mode,data_json,
      latest_input_seq,last_received_at,clarified_seq,decision_id) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(conversation_id,principal_id) DO UPDATE SET binding_id=excluded.binding_id,mode=excluded.mode,data_json=excluded.data_json,
      latest_input_seq=MAX(conversation_intake.latest_input_seq,excluded.latest_input_seq),
      last_received_at=MAX(conversation_intake.last_received_at,excluded.last_received_at),decision_id=excluded.decision_id`,
    context.conversationId, context.principalId, input.binding_id, choice.mode, JSON.stringify(data), input.input_seq, input.created_at, null, context.decisionId);
    return data;
  }
  due(waitMs = 2000, now = Date.now()) {
    return this.store.all(`SELECT p.* FROM conversation_intake p WHERE p.mode='wait' AND p.last_received_at+?<=?
      AND (p.clarified_seq IS NULL OR p.clarified_seq<p.latest_input_seq)
      AND json_extract(p.data_json,'$.preparedInputSeq')=p.latest_input_seq
      AND EXISTS(SELECT 1 FROM conversation_members m WHERE m.conversation_id=p.conversation_id AND m.principal_id=p.principal_id)
      AND EXISTS(SELECT 1 FROM conversations c WHERE c.id=p.conversation_id AND c.status='active')
      AND EXISTS(SELECT 1 FROM conversation_decisions d WHERE d.id=p.decision_id AND d.state='completed')
      AND NOT EXISTS(SELECT 1 FROM conversation_decisions d WHERE d.conversation_id=p.conversation_id AND d.state IN ('running','interrupting'))
      AND NOT EXISTS(SELECT 1 FROM conversation_inputs i WHERE i.conversation_id=p.conversation_id AND i.status IN ('accepted','assigned'))`, waitMs, now);
  }
}
