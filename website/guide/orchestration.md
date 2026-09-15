# Orchestration and tasks

## What changes

A managed conversation agent handles the conversation and delegates substantial work to workers. Work has a persistent task record, so you can inspect progress, results, and cancellation independently of a reply.

Orchestration uses one boolean `gateway.orchestration` switch for all agents and connected channels. Per-agent `orchestration` contains conversation/task tuning. Orchestration is enabled by default. On upgrade, a missing `gateway.orchestration` is saved as `true`; an explicit `false` keeps legacy mode. Enabling orchestration sets and saves `gateway.headless: true`; interactive PTY mode is unsupported. The current process supervisor requires Linux; other platforms reject orchestration with `UNSUPPORTED_PROCESS_SUPERVISOR`.

Retain all existing required configuration fields. Set `gateway.orchestration` to `false` to opt out, or `true` to re-enable it. See [orchestration settings](../reference/orchestration-settings.md) before tuning worker limits.

## Conversation intake

The optional per-agent `orchestration.conversation.semanticIntake: true` prepares incomplete material while waiting for a complete instruction. `intakeWaitMs` defaults to 2000 ms after the latest received material. More material restarts the interval; a complete instruction proceeds without waiting another interval. Model processing can take longer, and recording/upload-in-progress signals are not part of this timer.

Executable work receives a contextual acknowledgement before task creation. Amendments update the relevant task. Greetings and directly answerable conversation use one normal answer without a separate task acknowledgement.

## Inspect actual work

After asking an agent to perform a bounded task, inspect it from the same authorized conversation. In supported private chats, `/tasks` opens task controls. CLI equivalents are:

```bash
claude-gateway tasks list --agent assistant --session SESSION_ID
claude-gateway tasks show TASK_ID --agent assistant --session SESSION_ID
claude-gateway tasks watch TASK_ID --agent assistant --session SESSION_ID
```

Replace the IDs with real identifiers from your session. The principal must belong to the session. `tasks list --all` includes finished work; pagination uses zero-based `--page` and `--page-size` from 1 to 100 (default 10). Ctrl+C stops watching only.

Confirm success from the retained result and relevant files or checks. CPU/I/O movement is evidence of process activity, not proof of useful progress or passing tests. A tool marked `returned` only means a result arrived.

## Answer a task question

When a worker needs your decision, the gateway sends a separate **Waiting for your answer** message with the task title and complete question. It retains the question in task history and does not append it to unrelated replies.

Use your channel's Reply action on that question message and send a text answer, or copy its question ID into an explicit command:

```text
/task_question QUESTION_UUID answer Use the existing database.
/task_question QUESTION_UUID snooze
/task_question QUESTION_UUID mute
```

You can also answer naturally without replying to the message. The Agent uses `task_answer` when your answer clearly identifies a pending question. If several tasks are waiting and your answer could apply to more than one, it asks which task you mean.

Telegram, Discord, Slack and LINE offer native **Remind in 1 hour** and **Mute reminders** controls; other channels provide text commands. Snooze postpones the next reminder by one hour. Mute lasts for the current question; a new question has its own reminders. Both leave the task waiting for your answer.

After the initial question, unanswered reminders arrive at intervals of 10 minutes, then 30 minutes, then 60 minutes. Later intervals remain one hour. Tune the base interval with `agents[].orchestration.tasks.questionReminderMs` (default `600000`); the sequence is 1×, 3×, then 6× that value. Reminder state survives gateway restarts.

An accepted answer is saved before the task continues when a worker slot is available. Reminders stop when the question is answered, superseded, or its task ends. A reminder never approves a decision, and answering does not grant additional execution or memory-writing permissions. Controls validate the question, session, chat/thread and user; stale or foreign questions cannot resume another task. See the [task answer API](../api/tasks.md#answer-a-task-question) for clients.

## Cancel and reconcile

```bash
claude-gateway tasks cancel TASK_ID --agent assistant --session SESSION_ID
```

Cancellation enters `cancel_requested`; it becomes `cancelled` after process termination is confirmed. `needs_reconciliation` with `CLEANUP_UNCONFIRMED` means cleanup is not proven and may need **Retry cleanup**. Stopping a host Docker client does not prove its container stopped.

Cancellation preserves files and prior side effects. Before retrying interrupted work, inspect current files, Git state, and test results. A stale progress message is not proof that later edits disappeared.

## Understand time limits

The `tasks.idleTimeoutMs` defaults to 300000 and marks quiet workers for inspection. It does not terminate them for silence alone. `tasks.maxDurationMs: 0` means no total deadline; a positive value is an explicit hard deadline. Startup and first-response budgets remain bounded.

`ORCHESTRATION_DISABLED` indicates legacy mode. `PROFILE_INVENTORY_MISMATCH` indicates a subprocess exposed tools outside its profile: restore a consistent gateway/MCP revision and retain the inventory check.

Orchestration covers text orchestration across Telegram, Discord, LINE, Slack, WhatsApp, WeChat, and API conversations. WeChat staged attachments are unsupported. Voice channel support is narrower; see [voice](./voice.md).
