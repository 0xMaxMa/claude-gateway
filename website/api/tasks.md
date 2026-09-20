# Tasks and worker lifecycle {#tasks-and-worker-lifecycle}

Worker execution defaults to the host Agent's existing workspace, or its app container. `default-worker` accepts general-purpose tasks without Git or `tasks.projectRoot`; an authorized directory can be included in task instructions. Explicit workspace policies remain unchanged.

New worker attempts record optional `harness` (`claude` or `codex`) and `harnessModel` fields. Older attempts can omit them. These describe actual worker routing; the conversational agent still uses Claude Code. Codex usage records contain observed aggregate input/cache/output counters, not an invented per-request breakdown or loaded-tool inventory. See [worker harnesses](../guide/worker-harnesses.md).

Task detail includes optional `harness` (`claude` or `codex`) from the latest recorded attempt. Queued work without a chosen harness and older records without this metadata omit it; clients must not infer it from the model name.

Worker MCP admission: only explicitly configured `isolated-worktree` execution of `default-worker` can return `WORKER_GIT_PROJECT_REQUIRED` with an actionable message and `retryable: true` before creating a task. Correct the worker profile or project configuration before resubmitting; retain `continue_task_id` for related work. This does not change public API authentication or container permissions.

Manual `POST /api/v1/crons/:id/run` for an orchestration agent remains pending through delegated work and the final Agent report. A queue acknowledgement is not a successful run result. The job timeout covers this wait; absent an explicit value, managed jobs have no fixed total wait deadline when worker maxDurationMs is zero. Normal chat/API requests still return their initial Agent response without waiting for workers.

Worker observation: `tasks.idleTimeoutMs` defaults to 300000 and now marks a quiet worker for inspection, **not termination**. Silence while a tool or subsequent model response is pending does not prove a stall. `tasks.defaultTimeoutMs` remains an alias for this observation threshold. Worker startup/first-response budgets remain bounded; `tasks.maxDurationMs: 0` means no total deadline (a positive value is an explicit hard deadline). Cancellation, process exit, and terminal results still end work. No completed or interrupted side effects are replayed automatically.

Every 15 seconds, managed workers publish `task.execution` observations, available through task status, activity, dashboard data and `/tasks`. Linux host workers sample the owned process tree's CPU ticks, logical read/write counters (including pipes), and child membership without reading argv/environment. PID start times fence reused identities. CPU/I/O movement is **process activity**, not proof that tests passed or useful work advanced. Diagnostics use tool protocol metadata rather than parsing framework-specific output. `lastTool` records the tool name, `returned` or `error`, timestamp, and an exit code only when explicitly provided as numeric metadata. `returned` means a result was received, not that the task succeeded. Raw tool output and test counts are not copied into diagnostics; relevant verification belongs in the worker’s task progress/result. Quiet/sleeping/network-waiting work is retained and cancellable. Non-Linux or inaccessible telemetry, including app-container internals, is explicitly unavailable; Docker-client host activity is not represented as container progress. Detached/reparented children outside the owned group cannot be observed reliably. Observation timestamps are separate from last actual activity, so polling alone is not evidence of activity. Telegram task details separate Progress from Diagnostics and show Elapsed from the first start (frozen after completion). Terminal task observations are historical, not a live process guarantee.

After an interrupted task, the Agent must compare the timestamps of progress and execution evidence and verify current files, commits and test results before claiming what remains. A stale progress report is not proof that later edits did not happen.


Task cancellation also supports `needs_reconciliation` and `recovering`. The
request enters `cancel_requested`; the scheduler confirms process termination
before marking it `cancelled`. Unconfirmed cleanup returns
`needs_reconciliation` with `CLEANUP_UNCONFIRMED` and a **Retry cleanup** button.
Legacy process records without a kernel identity can be closed when their process
group is absent, but a live group is not signalled based on its PID alone.
Container execution requires separate proof; stopping its host Docker client is
not proof of container termination. Cancellation preserves workspace files and
prior side effects. The scoped `task_cancel` tool accepts optional
`replaced_by_task_id` to record a known replacement in the same conversation.

`task_status` includes recorded workspace modes/paths, file paths observed in tool
calls, and recent tool descriptions. These are historical evidence, explicitly
marked `currentFilesystemVerified: false`; neither timeout nor an absent remote
branch proves that local work was deleted. The Agent must verify actual files/Git
state before claiming work was lost. Task browser `Updated` includes the latest
persisted tool activity, not only state changes.


## Orchestration response text {#orchestration-response-text-and-voice-replay}

`GET /api/v1/agents/:agentId/sessions/:sessionId/activity/stream` is an authenticated SSE stream. Each `data:` frame contains `{responseId, text, final}`; `text` is the current display-text snapshot, not a delta. Replace the previous snapshot with the same responseId. Current generating responses are replayed on connection; canonical message history is the source for completed responses. Heartbeat comments keep the connection alive. Agent access and conversation membership are required. Slow clients are disconnected and may reconnect.

History messages may include `responseId` for orchestration assistant responses; clients should use it to reconcile streamed and persisted messages. Completed response timestamps in history and activity snapshots use the response completion time, so an earlier acknowledgement stays before its later answer after refresh. Decision start times remain separate execution metadata.

## List, inspect and cancel tasks {#cancel-an-orchestration-task}

`GET /api/v1/agents/:agentId/sessions/:sessionId/tasks` lists active tasks in the session. Query: `page` (zero-based, default 0), `page_size` (1–100, default 10), `all=true` to include finished tasks. Returns `{page, pages, total, tasks}`; an out-of-range page is clamped to the last page. Entries include title, state, progress, activity, timing and cancellation metadata. List previews are bounded; use the detail endpoint for the complete retained result.

`GET /api/v1/agents/:agentId/sessions/:sessionId/tasks/:taskId` returns `{task}` with the task snapshot, full retained result, progress and activity details. Worker-only installed skill bodies are excluded. Both GET endpoints require agent access and conversation membership; cross-session task IDs are rejected. Invalid pagination returns 400; inaccessible tasks return 403. GET and cancel endpoints return `409 {"error":"ORCHESTRATION_DISABLED"}` when orchestration is disabled.

The dedicated `claude-gateway tasks list|show|watch|cancel` CLI wraps these controls. `watch` polls every three seconds (no LLM call), prints changed snapshots and accepts Ctrl+C without cancelling work. Its list view remains on the selected page; detail watch exits when the task completes, fails or is cancelled. No offline database mutation or task replay is performed.

`POST /api/v1/agents/:agentId/sessions/:sessionId/tasks/:taskId/cancel` cancels one task without an inference turn. Requires an API key with access to the agent and membership of the task conversation; the task must belong to the supplied session. Returns `{ "task": { "taskId": "...", "state": "cancel_requested" } }` while stopping, or `cancelled` once stopped. A task that already finished retains its terminal state. Existing files and completed side effects are retained.



## Answer a task question {#answer-a-task-question}

A task in `waiting_input` retains `pendingQuestion: {questionId, text, revision}`. The task detail endpoint includes the full retained `pendingQuestion.text`; list/control previews may be shorter and expose `questionId` for answering. The gateway sends each question as a separate message, with the task title and full question, and retains it in conversation history. Questions are not repeated in unrelated Agent replies.

`POST /api/v1/agents/:agentId/sessions/:sessionId/tasks/:taskId/answer`

```json
{
  "questionId": "<question-uuid>",
  "answer": "Use the existing database."
}
```

Requires an authenticated API key with access to the agent, membership of the task conversation, and effective tool access under the existing Agent/API-key `allow_tools` policy. The task must belong to the supplied session and the question must be the current unanswered question. A non-empty answer is required. Returns `{task}` with the updated task control snapshot; saving the answer does not imply that a worker has already resumed. The answer preserves the task's existing execution and memory-writing capabilities.

Invalid IDs or an empty/missing answer return `400`; inaccessible or stale questions and denied tool access return `403`. Disabled orchestration returns `409 {"error":"ORCHESTRATION_DISABLED"}`. Repeating the same saved answer is idempotent; a conflicting answer to an already answered question is rejected. The question ID prevents an old response from answering a newer question on the same task.

Ordinary channel replies, including Reply to a delivered question, go through the Agent before `task_answer` is called. Reply metadata identifies context; consultation is not automatically committed as an answer. The explicit `/task_question <question-uuid> answer <text>` command and this authenticated endpoint still submit an intentional answer directly.

Questions and contextual reminders are natural separate Agent messages without reminder buttons. The Agent uses its scoped `task_question` tool to ask, discuss, defer, mute or resume reminders; none of these actions approves or resumes work. Reminder eligibility requires at least three new user messages and a cooldown of 1×, 3×, then 6× `agents[].orchestration.tasks.questionReminderMs` (default `600000`). The Agent decides whether to remind during conversation; these limits do not schedule recurring outbound messages. Preferences survive restart and answered/replaced questions are excluded.

Legacy `/task_question <question-uuid> snooze` and `mute` commands remain available. Snooze defers one hour; mute applies to the current question. All explicit controls retain session, channel, chat/thread and principal authorization.

## Telegram live task menus and selection confirmations {#telegram-live-task-menus-and-selection-confirmations}

In orchestration mode, `/tasks` keeps one live task menu per private chat.
Opening it again deletes the previous menu (or closes its controls if deletion
is unavailable). The receiver remembers the latest menu across restarts.
Both the list and task detail refresh every three seconds, editing Telegram only
when displayed content changes. Navigation stays on the selected page/task;
auto-refresh never repeats a Stop action. Completed task details stop refreshing
after showing the final state. Dismiss, session changes, revoked access, and
message deletion stop tracking. Telegram `retry_after` delays further updates.
These reads do not invoke the agent or consume inference tokens.

Selecting `/voice` or `/voices` replaces the menu with a persistent confirmation
and removes its buttons, matching `/models`. Dismiss does not record a selection.



## App container admission and cold boot

At startup, orchestration migrates registered, running app-agent containers that still use legacy host Claude settings/seed-file mounts, before starting their Agent runners. Migration verifies Compose ownership and all remaining isolation constraints, backs up the generated Compose/Dockerfile, and recreates only the `agent` service with the current seed-directory mount (`--no-deps --no-build`). App/database services and mounted workspace/media remain intact. Unknown mounts or privileged containers are rejected; migration never enables a host fallback or restores unsafe mounts automatically.

App-Agent cold boot: registered orchestration App Agents defer admission until their own Compose restore succeeds. Each ready app runs legacy-mount migration and strict container admission before its Agent starts; unrelated ready apps do not wait for the whole restore batch. Migration can inspect a stopped container's configuration, but runtime admission and the post-migration check still require a running container. Unknown mounts and disabled `no-new-privileges` remain rejected. The effective boolean is checked in option order, including explicit false and overrides.

## Report retries

Automatic task-report failures retry the persisted result with exponential backoff (5 seconds initially, capped at 5 minutes), without spawning/replaying the worker or granting execution permission. The retry clock is derived from durable decision history, so restart and pre-upgrade failed reports retain their state. Eligible/scheduled conversations are filtered before pagination; cooling-down or busy chats do not block other reports. A stopped reporting turn is not automatically retried. A later user turn can still consume its pending updates. Successful reports mark their notifications handled and are not sent again.

Worker cron requests preserve the manual-run wait semantics above. A lost response
from a dispatched mutation is reported as `CRON_OUTCOME_UNKNOWN` with
`retryable: false` on the private task bridge. Revoking the worker ticket aborts
its HTTP wait, not the separately executing cron job; inspect run history before
retrying. This does not change the public cron endpoint response schema.
