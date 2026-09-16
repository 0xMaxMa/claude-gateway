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

When work needs your decision, the Agent asks naturally in a separate message. It can combine several pending questions in one message. There are no reminder/mute buttons or system-card instructions.

Reply normally, with or without your channel's Reply action. Text, voice transcripts and attachment context go through the Agent first. Reply identifies the question being discussed; it is **not automatic consent**. A question such as “Can you try another approach?” stays a discussion until the Agent understands whether you want an answer, a changed goal, or more explanation. Only `task_answer` commits an interpreted answer; `task_update` handles an authorized change of goal.

Pending questions remain visible to the Agent even when you change topics. After replying to the new topic, it can ask a short separate reminder. The gateway enforces a minimum cooldown and at least three new user messages since the last question or discussion. With the default `questionReminderMs=600000`, cooldowns are 10, 30, then 60 minutes, capped at 60 minutes. These are eligibility limits, **not a recurring message schedule**. The Agent chooses whether a reminder is useful; idle conversations do not receive recurring timer reminders. A new question wakes the Agent to prepare its first message.

Say “leave it for later” to defer reminders (one hour by default), or “do not ask again” to mute that question. Discussing the question renews its cooldown. These preferences and question/message associations survive restart. Asking, discussing, deferring and muting never resume a worker or grant execution permission. Questions stop when answered, replaced or their task ends.

Explicit controls remain available for clients that intentionally bypass interpretation:

```text
/task_question QUESTION_UUID answer Use the existing database.
/task_question QUESTION_UUID snooze
/task_question QUESTION_UUID mute
```

These commands and the [task answer API](../api/tasks.md#answer-a-task-question) require a current question and the correct authenticated conversation. An accepted answer is saved before work resumes when a worker slot is available.

A finished investigation and a proposed implementation are different stages. Completion reports should identify what finished and whether a follow-up task is actually queued/running. A suggested next step is not a promise that execution has started, and read-only investigation does not authorize deployment.

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
