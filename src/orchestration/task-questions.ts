import { ControlMenu, ControlScope } from './channel-controls';
import { DecisionService } from './decisions';
import { DeliveryControl } from './delivery';
import { AcceptInput, OrchestrationStore, Row } from './store';
import { TaskService } from './tasks/service';
import { CommandContext, OrchestrationError } from './types';

const UUID = '[a-f0-9-]{36}';
/** Durable pending questions. Agents interpret replies and choose when to ask. */
export class TaskQuestions {
  constructor(private store: OrchestrationStore, private tasks: TaskService, private decisions: DecisionService,
    private deliver: (responseId: string, bindingId: string, text: string, controls: DeliveryControl[]) => void,
    private publish: (sessionId: string, responseId: string, text: string) => void,
    private reminderMs: () => number) {}

  tick(now = Date.now()): void {
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
        this.store.run('INSERT OR IGNORE INTO task_question_attention(question_id) VALUES(?)', question.questionId);
        if (Number(saved.state_version) !== task.stateVersion) this.store.run('UPDATE task_questions SET state_version=? WHERE question_id=?', task.stateVersion, question.questionId);
        this.suppressQuestionReports(question.questionId);
      }
    });
    this.flushPrompts(now);
  }

  context(conversationId: string, principalId: string, now = Date.now()) {
    this.store.assertMember(conversationId, principalId);
    return this.store.all(`SELECT q.*,json_extract(t.snapshot_json,'$.title') title,t.snapshot_json,a.last_discussed_at,
      COALESCE((SELECT MAX(r.created_at) FROM task_question_messages m JOIN assistant_responses r ON r.id=m.response_id WHERE m.question_id=q.question_id),0) last_asked_at
      FROM task_questions q JOIN tasks t ON t.id=q.task_id LEFT JOIN task_question_attention a ON a.question_id=q.question_id
      WHERE t.conversation_id=? AND q.closed=0 AND t.state='waiting_input'`, conversationId).map(row => {
      const pending = JSON.parse(String(row.snapshot_json)).pendingQuestion;
      const since = Math.max(Number(row.last_asked_at), Number(row.last_discussed_at ?? 0));
      const messagesSince = Number(this.store.get("SELECT COUNT(*) n FROM conversation_inputs WHERE conversation_id=? AND store_user_message=1 AND created_at>?", conversationId, since)!.n);
      const queued = Boolean(this.store.get("SELECT id FROM task_question_prompts WHERE state='pending' AND EXISTS(SELECT 1 FROM json_each(question_ids_json) WHERE value=?)", row.question_id)
        || this.store.get("SELECT d.id FROM deliveries d JOIN task_question_messages m ON m.response_id=d.response_id WHERE m.question_id=? AND d.state IN ('pending','sending') LIMIT 1", row.question_id));
      return { taskId: String(row.task_id), questionId: String(row.question_id), title: String(row.title), question: pending?.text,
        askedCount: Number(row.reminder_count), lastAskedAt: Number(row.last_asked_at), lastDiscussedAt: Number(row.last_discussed_at ?? 0),
        nextReminderAt: Number(row.next_reminder_at), muted: Boolean(row.muted), messagesSince,
        eligibleToAsk: !queued && !row.muted && now >= Number(row.next_reminder_at) && (!Number(row.reminder_count) || messagesSince >= 3) };
    });
  }

  /** Wake the agent for a new question, not for recurring timer-driven reminders. */
  initialReviews(activeSessions: string[], now = Date.now()): Row[] {
    return this.store.all(`SELECT DISTINCT c.* FROM task_questions q JOIN tasks t ON t.id=q.task_id
      JOIN conversations c ON c.id=t.conversation_id JOIN task_question_attention a ON a.question_id=q.question_id
      WHERE q.closed=0 AND q.muted=0 AND q.reminder_count=0 AND q.next_reminder_at<=? AND t.state='waiting_input' AND c.status='active'
      AND (a.last_review_at=0 OR a.last_review_at+?<=?)
      AND c.agent_session_id NOT IN (SELECT value FROM json_each(?))
      AND NOT EXISTS(SELECT 1 FROM notifications n WHERE n.conversation_id=c.id AND n.status='pending')
      AND NOT EXISTS(SELECT 1 FROM conversation_inputs i WHERE i.conversation_id=c.id AND i.status IN ('accepted','assigned'))
      LIMIT 20`, now, this.reminderMs(), now, JSON.stringify(activeSessions));
  }
  reviewed(conversationId: string, now = Date.now()): void {
    this.store.run(`UPDATE task_question_attention SET last_review_at=? WHERE question_id IN
      (SELECT q.question_id FROM task_questions q JOIN tasks t ON t.id=q.task_id WHERE t.conversation_id=? AND q.closed=0)`, now, conversationId);
  }

  manage(context: CommandContext, args: Record<string, unknown>): unknown {
    const ids = args.question_ids;
    const action = args.action;
    if (!Array.isArray(ids) || !ids.length || ids.length > 20 || ids.some(id => typeof id !== 'string' || !new RegExp(`^${UUID}$`).test(id)) || new Set(ids).size !== ids.length || !['ask','discuss','defer','mute','resume'].includes(String(action))) throw new OrchestrationError('INVALID_INPUT');
    if (action === 'ask' && (typeof args.text !== 'string' || !args.text.trim() || Buffer.byteLength(args.text) > 16000)) throw new OrchestrationError('INVALID_INPUT');
    if (args.delay_ms !== undefined && (typeof args.delay_ms !== 'number' || !Number.isSafeInteger(args.delay_ms) || args.delay_ms < 60000 || args.delay_ms > 30*86400000)) throw new OrchestrationError('INVALID_INPUT');
    return this.store.compose(() => this.tasks.questionAction(context, args, () => {
      const current = this.context(context.conversationId, context.principalId);
      const questions = ids.map(id => {
        const question = current.find(item => item.questionId === id);
        if (!question) throw new OrchestrationError('STALE_QUESTION');
        return question;
      });
      const input = this.store.get('SELECT store_user_message FROM conversation_inputs WHERE id=?', context.inputId)!;
      if (['defer','mute','resume','discuss'].includes(String(action)) && !input.store_user_message) throw new OrchestrationError('USER_INPUT_REQUIRED');
      const now = Date.now();
      if (action === 'ask') {
        if (!input.store_user_message && questions.some(q => q.askedCount > 0)) throw new OrchestrationError('USER_INPUT_REQUIRED');
        if (questions.some(q => !q.eligibleToAsk)) throw new OrchestrationError('QUESTION_REMINDER_NOT_DUE');
        const bindings = ids.map(id => String(this.store.get('SELECT binding_id FROM task_questions WHERE question_id=?', id)!.binding_id));
        if (new Set(bindings).size !== 1) throw new OrchestrationError('QUESTION_BINDING_MISMATCH');
        // Deliver only after the ordinary reply finishes, in a separate message.
        // A durable intent also survives a crash between the response and delivery.
        this.store.run('INSERT INTO task_question_prompts(id,decision_id,conversation_id,binding_id,question_ids_json,text) VALUES(?,?,?,?,?,?)',
          context.actionId, context.decisionId, context.conversationId, bindings[0], JSON.stringify(ids), String(args.text).trim());
      } else {
        for (const id of ids) {
          this.store.cancelQuestionDeliveries(id);
          this.store.run("UPDATE task_question_prompts SET state='cancelled' WHERE state='pending' AND EXISTS(SELECT 1 FROM json_each(question_ids_json) WHERE value=?)", id);
          if (action === 'discuss') {
            this.store.run('UPDATE task_question_attention SET last_discussed_at=? WHERE question_id=?', now, id);
            this.store.run('UPDATE task_questions SET next_reminder_at=? WHERE question_id=?', now + this.reminderMs(), id);
          } else this.store.run('UPDATE task_questions SET muted=?,next_reminder_at=? WHERE question_id=?', action === 'mute' ? 1 : 0,
            action === 'resume' ? now : now + Number(args.delay_ms ?? 3600000), id);
        }
      }
      return { action, questionIds: ids, status: action === 'ask' ? 'queued_after_reply' : 'saved', taskStateUnchanged: true };
    }));
  }

  flushPrompts(now = Date.now()): void {
    const published: Array<[string,string,string]> = [];
    this.store.compose(() => {
      for (const prompt of this.store.all(`SELECT p.*,d.state decision_state,c.agent_session_id,c.status conversation_status FROM task_question_prompts p
        JOIN conversation_decisions d ON d.id=p.decision_id JOIN conversations c ON c.id=p.conversation_id
        WHERE p.state='pending' AND d.state NOT IN ('running','interrupting')`)) {
        const ids = JSON.parse(String(prompt.question_ids_json)) as string[];
        const valid = prompt.decision_state === 'completed' && prompt.conversation_status === 'active' && ids.every(id => {
          const row = this.store.get('SELECT q.*,t.state task_state,t.snapshot_json FROM task_questions q JOIN tasks t ON t.id=q.task_id WHERE q.question_id=?',id);
          return row && !row.closed && !row.muted && row.task_state === 'waiting_input' && JSON.parse(String(row.snapshot_json)).pendingQuestion?.questionId === id;
        });
        if (!valid) { this.store.run("UPDATE task_question_prompts SET state='cancelled' WHERE id=?",prompt.id); continue; }
        const responseId = this.decisions.notice(String(prompt.conversation_id), String(prompt.text), false);
        for (const id of ids) {
          this.store.run('INSERT INTO task_question_messages VALUES(?,?)',responseId,id);
          const count = Number(this.store.get('SELECT reminder_count FROM task_questions WHERE question_id=?',id)!.reminder_count)+1;
          this.store.run('UPDATE task_questions SET reminder_count=?,next_reminder_at=? WHERE question_id=?',count,now+this.reminderMs()*(count===1?1:count===2?3:6),id);
        }
        this.deliver(responseId,String(prompt.binding_id),String(prompt.text),[]);
        this.store.run("UPDATE task_question_prompts SET state='sent' WHERE id=?",prompt.id);
        published.push([String(prompt.agent_session_id),responseId,String(prompt.text)]);
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
    this.store.run("UPDATE task_question_prompts SET state='cancelled' WHERE state='pending' AND EXISTS(SELECT 1 FROM json_each(question_ids_json) WHERE value=?)", questionId);
    this.store.run('UPDATE task_questions SET muted=?,next_reminder_at=? WHERE question_id=?', action === 'mute' ? 1 : 0, Date.now() + 3600000, questionId);
    return { text: `${action === 'mute' ? 'Reminders muted' : 'Reminder snoozed for 1 hour'} · ${task.title}\nThe task is still waiting for your answer.`, buttons: [] };
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
    // Only an explicit command bypasses inference; Reply is context, never consent.
    return /^\/task_question(?:\s|$)/.test(input.text.trim());
  }
  replyContext(input: AcceptInput): Row[] {
    if (!input.metadata?.repliedMessageId) return [];
    const rows = this.replyQuestions(input);
    if (rows.length) this.store.assertMember(String(rows[0].conversation_id), input.scope.principalId);
    return rows;
  }
  private replyQuestions(input: AcceptInput): Row[] {
    const scope = { channel: input.scope.source, chatId: input.scope.chatId, thread: input.scope.threadKey, sessionId: input.scope.agentSessionId };
    return this.store.all(`SELECT DISTINCT m.question_id,q.task_id,q.closed,c.id conversation_id FROM task_question_messages m JOIN task_questions q ON q.question_id=m.question_id
      JOIN conversation_bindings b ON b.id=q.binding_id JOIN conversations c ON c.id=b.conversation_id
      LEFT JOIN deliveries d ON d.response_id=m.response_id AND d.binding_id=b.id
      WHERE ((d.provider_message_id=? AND d.state='delivered') OR (b.channel='api' AND m.response_id=?))
      AND b.channel=? AND b.chat_id=? AND b.thread_key=? AND c.agent_session_id=? AND b.account_id=?`,
      input.metadata!.repliedMessageId!, input.metadata!.repliedMessageId!, scope.channel, scope.chatId, scope.thread, scope.sessionId, input.scope.accountId);
  }
}
