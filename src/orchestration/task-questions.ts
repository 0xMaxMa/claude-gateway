import { ControlMenu, ControlScope } from './channel-controls';
import { DecisionService } from './decisions';
import { DeliveryControl } from './delivery';
import { AcceptInput, OrchestrationStore, Row, payloadHash } from './store';
import { TaskService } from './tasks/service';
import { OrchestrationError } from './types';

const UUID = '[a-f0-9-]{36}';
/** Questions are durable user controls, not ordinary model-generated progress reports. */
export class TaskQuestions {
  constructor(private store: OrchestrationStore, private tasks: TaskService, private decisions: DecisionService,
    private deliver: (responseId: string, bindingId: string, text: string, controls: DeliveryControl[]) => void,
    private publish: (sessionId: string, responseId: string, text: string) => void,
    private reminderMs: () => number) {}

  tick(now = Date.now()): void {
    const published: Array<[string, string, string]> = [];
    this.store.compose(() => {
      // A pending message must not ask for an already answered or replaced question.
      for (const row of this.store.all(`SELECT q.* FROM task_questions q JOIN tasks t ON t.id=q.task_id
        WHERE (q.closed=0 OR EXISTS(SELECT 1 FROM deliveries d JOIN task_question_messages m ON m.response_id=d.response_id WHERE m.question_id=q.question_id AND d.state='pending')) AND (t.state!='waiting_input' OR COALESCE(json_extract(t.snapshot_json,'$.pendingQuestion.questionId'),'')!=q.question_id)`)) {
        this.store.run('UPDATE task_questions SET closed=1 WHERE question_id=?', row.question_id);
        this.suppressQuestionReports(String(row.question_id));
        this.store.cancelQuestionDeliveries(String(row.question_id));
      }
      for (const row of this.store.all(`SELECT t.*,c.agent_session_id FROM tasks t JOIN conversations c ON c.id=t.conversation_id
        WHERE t.state='waiting_input' AND c.status='active'`)) {
        const task = this.store.task(String(row.id))!, question = task.pendingQuestion;
        if (!question || question.revision !== task.revision) continue;
        let saved = this.store.get('SELECT * FROM task_questions WHERE question_id=?', question.questionId);
        if (!saved) {
          // Preserve the originating channel/thread, never pick an arbitrary linked channel.
          const binding = this.store.get('SELECT binding_id FROM conversation_inputs WHERE id=?', task.initiatingInputId);
          if (!binding) continue;
          this.store.run('INSERT INTO task_questions(question_id,task_id,revision,state_version,binding_id,next_reminder_at) VALUES(?,?,?,?,?,?)',
            question.questionId, task.taskId, question.revision, task.stateVersion, binding.binding_id, now);
          saved = this.store.get('SELECT * FROM task_questions WHERE question_id=?', question.questionId)!;
        }
        if (!saved.closed && !saved.muted && Number(saved.next_reminder_at) <= now) {
          const pending = this.store.get(`SELECT d.id FROM deliveries d JOIN task_question_messages m ON m.response_id=d.response_id
            WHERE m.question_id=? AND d.state IN ('pending','sending') LIMIT 1`, question.questionId);
          if (!pending) {
            const prefix = Number(saved.reminder_count) ? 'Reminder · Waiting for your answer' : 'Waiting for your answer';
            const command = `/task_question ${question.questionId}`;
            const channel = this.store.get('SELECT channel FROM conversation_bindings WHERE id=?', saved.binding_id)!.channel;
            const fallback = ['telegram', 'discord', 'slack', 'line'].includes(String(channel)) ? '' : `\n\n${command} snooze\n${command} mute`;
            const text = `${prefix}\n${task.title}\n\n${question.text}\n\nReply to this message with your answer, or use:\n${command} answer <your answer>${fallback}`;
            const responseId = this.decisions.notice(task.conversationId, text, false);
            this.store.run('INSERT INTO task_question_messages VALUES(?,?)', responseId, question.questionId);
            this.deliver(responseId, String(saved.binding_id), text, [
              { label: 'Remind in 1 hour', data: `orch:q:${question.questionId}:snooze` },
              { label: 'Mute reminders', data: `orch:q:${question.questionId}:mute` },
            ]);
            const count = Number(saved.reminder_count) + 1;
            this.store.run('UPDATE task_questions SET reminder_count=?,next_reminder_at=? WHERE question_id=?', count,
              now + this.reminderMs() * (count === 1 ? 1 : count === 2 ? 3 : 6), question.questionId);
            published.push([String(row.agent_session_id), responseId, text]);
          }
        }
        if (Number(saved.state_version) !== task.stateVersion) this.store.run('UPDATE task_questions SET state_version=? WHERE question_id=?', task.stateVersion, question.questionId);
        this.suppressQuestionReports(question.questionId);
      }
    });
    for (const item of published) this.publish(...item);
  }

  private suppressQuestionReports(questionId: string): void {
    // Earlier pending progress for this task is superseded by its current question.
    // The durable version fence excludes later terminal results or replacement questions.
    const question = this.store.get('SELECT task_id,state_version FROM task_questions WHERE question_id=?', questionId)!;
    this.store.run("UPDATE notifications SET status='handled' WHERE task_id=? AND task_state_version<=? AND status='pending'", question.task_id, question.state_version);
    this.store.run(`UPDATE outbox SET state='completed' WHERE kind='notification' AND state='pending' AND json_extract(payload_json,'$.notificationId') IN
      (SELECT id FROM notifications WHERE task_id=? AND task_state_version<=? AND status='handled')`, question.task_id, question.state_version);
  }

  private owned(scope: ControlScope, questionId: string): Row {
    const row = this.store.get(`SELECT q.*,t.conversation_id,c.agent_session_id FROM task_questions q JOIN tasks t ON t.id=q.task_id
      JOIN conversations c ON c.id=t.conversation_id JOIN conversation_bindings b ON b.id=q.binding_id
      WHERE q.question_id=? AND c.agent_session_id=? AND b.channel=? AND b.chat_id=? AND (b.thread_key=? OR (b.channel='slack' AND b.thread_key='' AND EXISTS(
        SELECT 1 FROM task_question_messages m JOIN deliveries d ON d.response_id=m.response_id
          WHERE m.question_id=q.question_id AND d.binding_id=b.id AND d.state='delivered' AND d.provider_message_id=?)))`,
      questionId, scope.sessionId, scope.channel, scope.chatId, scope.thread, scope.thread);
    if (!row) throw new OrchestrationError('QUESTION_NOT_FOUND');
    this.store.assertMember(String(row.conversation_id), scope.principalId);
    return row;
  }

  handle(scope: ControlScope, text: string, inputId?: string): ControlMenu | undefined {
    return this.store.compose(() => this.apply(scope, text, inputId));
  }
  private apply(scope: ControlScope, text: string, inputId?: string): ControlMenu | undefined {
    const command = new RegExp(`^/task_question (${UUID}) (answer|snooze|mute)(?:\\s+([\\s\\S]+))?$`).exec(text.trim());
    const callback = new RegExp(`^/orch q:(${UUID}):(snooze|mute)$`).exec(text.trim());
    if (!command && !callback) return undefined;
    const [, questionId, action] = (command ?? callback)!;
    const row = this.owned(scope, questionId);
    if (action === 'answer') {
      const task = this.tasks.answerByUser(String(row.conversation_id), scope.principalId, String(row.task_id), questionId, command?.[3] ?? '', inputId);
      this.store.run('UPDATE task_questions SET closed=1 WHERE question_id=?', questionId);
      this.suppressQuestionReports(questionId);
      return { text: `Answer received · ${task.title}\nThe answer is saved. Current task status: ${task.state}.`, buttons: [] };
    }
    const task = this.store.task(String(row.task_id));
    if (row.closed || task?.state !== 'waiting_input' || task.pendingQuestion?.questionId !== questionId) throw new OrchestrationError('STALE_QUESTION');
    this.store.cancelQuestionDeliveries(questionId);
    this.store.run('UPDATE task_questions SET muted=?,next_reminder_at=? WHERE question_id=?', action === 'mute' ? 1 : 0, Date.now() + 3600000, questionId);
    return { text: `${action === 'mute' ? 'Reminders muted' : 'Reminder snoozed for 1 hour'} · ${task.title}\nThe task is still waiting for your answer.`, buttons: [] };
  }

  /** Only a platform reply to a persisted question message is an unambiguous answer. */
  answerReply(input: AcceptInput, inputId: string): ControlMenu | undefined {
    if (!input.text.trim() || input.attachmentIds?.length || !input.metadata?.repliedMessageId || input.text.trim().startsWith('/')) return undefined;
    const row = this.replyQuestion(input);
    if (!row) return undefined;
    const scope = { channel: input.scope.source, chatId: input.scope.chatId, thread: input.scope.threadKey, sessionId: input.scope.agentSessionId, principalId: input.scope.principalId };
    return this.handle(scope, `/task_question ${row.question_id} answer ${input.text}`, inputId);
  }

  normalizeReply(input: AcceptInput): AcceptInput {
    if (input.scope.source !== 'slack' || !input.scope.threadKey || input.metadata?.repliedMessageId !== input.scope.threadKey) return input;
    const row = this.store.get(`SELECT b.conversation_id FROM task_question_messages m JOIN deliveries d ON d.response_id=m.response_id
      JOIN conversation_bindings b ON b.id=d.binding_id JOIN conversations c ON c.id=b.conversation_id
      WHERE d.provider_message_id=? AND d.state='delivered' AND b.channel='slack' AND b.chat_id=? AND b.account_id=?
        AND b.thread_key='' AND c.agent_session_id=?`, input.scope.threadKey, input.scope.chatId, input.scope.accountId, input.scope.agentSessionId);
    if (!row) return input;
    this.store.assertMember(String(row.conversation_id), input.scope.principalId);
    return {...input, scope: {...input.scope, threadKey: ''}};
  }

  matches(input: AcceptInput): boolean {
    if (/^\/task_question(?:\s|$)/.test(input.text.trim())) return true;
    if (!input.text.trim() || input.text.trim().startsWith('/') || input.attachmentIds?.length || !input.metadata?.repliedMessageId) return false;
    const question = this.replyQuestion(input);
    if (!question) return false;
    if (input.scope.source !== 'slack' || !question.closed) return true;
    // Slack repeats the root message as reply metadata for every later thread message.
    // Once answered, only an actual retry of the saved receipt is a question control.
    if (!input.ingressKey) return false;
    const s = input.scope;
    const key = payloadHash([this.store.agentId,s.source,s.accountId,s.chatId,s.threadKey,s.principalId,input.ingressKey]);
    return Boolean(this.store.get(`SELECT i.input_id FROM ingress_receipts i JOIN conversation_decisions d
      ON d.kind='notice' AND EXISTS(SELECT 1 FROM json_each(d.input_ids_json) WHERE value=i.input_id) WHERE i.ingress_key=?`, key));
  }
  private replyQuestion(input: AcceptInput): Row | undefined {
    const scope = { channel: input.scope.source, chatId: input.scope.chatId, thread: input.scope.threadKey, sessionId: input.scope.agentSessionId };
    return this.store.get(`SELECT DISTINCT m.question_id,q.closed FROM task_question_messages m JOIN task_questions q ON q.question_id=m.question_id JOIN deliveries d ON d.response_id=m.response_id
      JOIN conversation_bindings b ON b.id=d.binding_id JOIN conversations c ON c.id=b.conversation_id
      WHERE d.provider_message_id=? AND d.state='delivered' AND b.channel=? AND b.chat_id=? AND b.thread_key=? AND c.agent_session_id=?`,
      input.metadata!.repliedMessageId!, scope.channel, scope.chatId, scope.thread, scope.sessionId);
  }
}
