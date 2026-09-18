# Orchestration and tasks

## What changes

A managed conversation agent handles the conversation and delegates substantial work to workers. Work has a persistent task record, so you can inspect progress, results, and cancellation independently of a reply.

Orchestration uses one boolean `gateway.orchestration` switch for all agents and connected channels. Per-agent `orchestration` contains conversation/task tuning. Orchestration is enabled by default. On upgrade, a missing `gateway.orchestration` is saved as `true`; an explicit `false` keeps legacy mode. Enabling orchestration sets and saves `gateway.headless: true`; interactive PTY mode is unsupported. The current process supervisor requires Linux; other platforms reject orchestration with `UNSUPPORTED_PROCESS_SUPERVISOR`.

Retain all existing required configuration fields. Set `gateway.orchestration` to `false` to opt out, or `true` to re-enable it. See [orchestration settings](../reference/orchestration-settings.md) before tuning worker limits.

## Conversation intake

The optional per-agent `orchestration.conversation.semanticIntake: true` prepares incomplete material while waiting for a complete instruction. `intakeWaitMs` defaults to 2000 ms after the latest received material. More material restarts the interval; a complete instruction proceeds without waiting another interval. Model processing can take longer, and recording/upload-in-progress signals are not part of this timer.

Executable work receives a contextual acknowledgement before task creation. Channel text must be delivered first; voice acknowledgement is best-effort and does not block dispatch when synthesis is slow, suppressed or unavailable. Live voice playback also does not gate task creation. Text delivery runs independently of slow speech from earlier responses. Only the original acknowledgement text gates dispatch; optional speech-failure notices do not. Each attempted task command is checked separately, including recovered receipts, so a successful task does not hide another rejected command. A partial-failure notice distinguishes rejected commands from the current task status, since a subsequent retry may already have succeeded. If an attempted task creation/update has no committed receipt, the gateway reports that work did not start instead of promising background progress. Amendments update the relevant task. Greetings and directly answerable conversation use one normal answer without a separate task acknowledgement.

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

If an automatic task report fails, its result stays pending for a later reporting attempt. Retry delays increase exponentially from five seconds to at most one hour and survive gateway restarts. These background failures remain in diagnostics rather than generating repeated chat or voice error messages. A new user message can trigger a turn immediately and still receives provider error details if that turn fails; it does not have to wait for the background retry delay. The retry delay is a fallback policy, not a prediction of the provider's quota reset time.

A corrected task-spawn validation error does not produce a partial-failure notice when a later command in the same turn successfully queues the same work. Automatic matching requires the same title, exact brief, predecessor, context references and continuation policy. If the brief changes, the caller must copy `retry_of` from the rejected spawn response to explicitly identify the correction. The reference only reconciles reporting for a validation failure in the same decision; it never bypasses admission or permissions. Unrelated failures, conflicting replays, permission errors and uncertain outcomes still produce a warning. Original tool errors remain in the transcript; this changes reporting, not authorization or execution.

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

## Context and worker continuity

The Agent receives complete retained results for the tasks being reported in its current turn. Other tasks appear as an index with links to `task_status`, so old results do not have to be inserted again into every prompt. Historical command receipts retain mutation IDs, versions and question state, with a reference to current task details instead of repeated progress, workflow and result payloads. This changes prompt composition, not the stored results or user authorization.

Related work can use `continue_task_id` to resume a compatible Claude Code session. The pool keeps idle continuation slots while it has room, and evicts the oldest idle slot when full. Idle slots contain no running process. Expiry, changed permissions/model/configuration, different workspaces and incompatible execution profiles can require a fresh CLI session. Reusing a worker ID alone is not proof that its CLI history was resumed. Unrelated work always receives a fresh session.

Installed skill metadata is sorted deterministically, and changing previously communicated reports are supplied as turn data rather than appended to system instructions. This keeps stable prompt prefixes stable without dropping the historical messages used to avoid duplicate updates. Cache reuse still depends on the model/provider; it is not guaranteed by gateway composition alone.

Capability discovery remains separate from execution permission. The Agent can inspect the enabled tools and skills catalog and delegate worker-only capabilities. General host workers retain the broad native tool inventory, including Bash, unless an explicit internal tool policy is supplied. Narrowing an inventory must preserve the tools required to finish the task; the gateway does not assume it can hot-load missing tools into an already running CLI session.

Task state notifications are coalesced before inference. Repeated delivery of the same task version does not create another notification; active or queued conversation input prevents another automatic report from being scheduled alongside it. A completed report consumes its assigned notifications. Failed reports retry with backoff without replaying the task itself. Internal supervision can still inspect a quiet worker even when there is no user-facing update: silence does not prove that intervention is unnecessary. Reporting decisions may choose silence when no meaningful new information should be sent.

## Inspect token usage

Open the admin dashboard and select **View token report** on a managed Agent session. The report opens in a new tab and separates Agent input handling, Agent progress/result reporting, and Worker execution. Session rows show Agent usage alongside the combined Agent/Worker total; task rows show the latest attempt’s usage and tools, matching the displayed worker/session identity. Earlier retries remain in the full report and combined session totals. Loaded tools and tools actually called are shown separately.

Token volume includes input, cache creation, cache reads and output. Thinking is already included in output and is not added twice. Cache creation duration is shown when the CLI reports it. These percentages describe token volume, **not billing cost**: cached reads and input may have different prices.

Each recorded turn includes the available request-level usage and its input/task/result context. Repeated content blocks and stream usage are deduplicated by provider message ID. A CLI turn aggregate is reconciled with request usage, not added as another request. Some providers expose only aggregate usage, so a turn total can be available without a complete request breakdown. Missing usage or tool inventory is **Unavailable**, not an inferred zero.

Usage is persisted in the per-agent `orchestration.db` table `token_turns` for turns recorded after this feature is installed. It survives gateway restarts; earlier sessions are not retroactively assigned estimated usage. Background skill-learning reviews are accounted for separately from foreground Agent/Worker totals. See the [report endpoints](../api/orchestration.md#session-token-reports) for programmatic access.

Use matched tasks, models, permissions and cache conditions when comparing releases. A smaller prompt or fewer repeated fields alone is not evidence of measured end-to-end savings or unchanged task quality.


Gateway execution tools in host/isolated workers use `tool_search` to retrieve original argument schemas and `tool_call` to invoke them. Discovery only searches tools already allowed by the worker policy. Calls keep the same task-ticket validation, original handler validation and cancellation path. Task reporting and memory tools remain direct; native tools retain their resolved policy. GetPod-configured connectors use a worker-local discovery/invocation adapter; MCP servers inherited directly from Claude Code configuration remain governed by Claude Code’s own loading behavior. This avoids depending on provider-specific support for deferred-tool reference blocks. A capability may remain available even when its full schema is not initially loaded; the dashboard distinguishes loaded schemas from the underlying tools actually called.

Discovery adds a model/tool round trip on first use. Smaller schema payloads do not guarantee lower end-to-end latency or billing. Compare the same model and task with measured cache usage before concluding that a workload is cheaper. The initial implementation has protocol/fixture coverage; matched live-model A/B measurements are required to establish production savings.

The dashboard uses the same **admin API key** login as before. Conversations and Tasks open detail drawers with retained session records and individual worker attempts; token reports open in a separate tab. Overview displays recorded UTC token activity, while Usage & tokens separates Agent and Worker totals. Reads run in a dedicated worker thread with bounded caches, pagination, and live updates; missing measurements are shown as unavailable.

### Dashboard session activity

The dashboard and Session token report share the same session status. After the last Agent turn ends, a conversation without active work stays **Idle** for one hour, even though its per-turn Claude Code process has been released. After more than one hour it shows **Stopped**, and both Context window cards show **—**. Active turns and non-terminal tasks retain their activity status. Context window retains the latest recorded measurement during the idle period; these display rules do not expire or delete conversation history or imply provider cache expiry.

### Native context compaction

Use `/compact` in a supported chat channel or the session compact API to ask Claude Code to compact its existing session. The gateway resumes that exact transcript, requires a native `compact_boundary` confirmation, and leaves all gateway chat-history files intact. It never reattaches a recent-message window after compaction. Busy sessions reject compaction until their current response finishes; workers continue independently. Missing transcripts and unsupported CLI behavior return an explicit error instead of invoking a separate history summarizer. Legacy sessions require an existing idle headless process.

Installed skill metadata is kept in the stable Agent system prefix, not appended to every resumed user message. Catalog changes refresh that prefix. Worker turn reports distinguish completed, failed and cancelled outcomes from the process lifecycle and expose recorded failure codes.
