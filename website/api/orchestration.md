# Orchestration and live voice {#orchestration-and-live-voice}

Orchestration is enabled gateway-wide with `gateway.orchestration` and automatically sets and saves `gateway.headless: true`. See [configuration, worker pooling and compatibility limits](/guide/orchestration). Existing message/session endpoints retain their authentication and session ownership rules. An initial message response may acknowledge a queued task; it is not proof of task completion. Worker results arrive later in the original conversation.

Telegram orchestration publishes an editable tool-activity message in the originating chat/topic. It uses the legacy Telegram layout: up to four previous details prefixed with `☑️ :`, the current detail prefixed with `🕐 :` when history exists, and `(elapsed: …)`. Agent and Worker tools share readable legacy labels; task IDs, raw MCP names and historical task lists are omitted. Details remain bounded and redacted. Updates are coalesced (at least four seconds apart per message) and respect Telegram retry-after responses. The message is deleted when all managed work in that conversation is idle. Elapsed-only updates run every ten seconds; tool detail changes can update sooner. This best-effort status is separate from durable task/result delivery and never controls worker execution; it does not replay inactive history at startup. Restarting during active work may create a new status message.

Worker reporting decisions receive the complete persisted results for their assigned notifications, including tasks older than the recent-task index. Other tasks appear as an index with `resultAvailable` and a `task_status` reference, not a shortened report. MCP `task_status` with `task_id` returns the full retained result and evidence; without it, the tool returns the decision's task index/current reports. Historical command receipts reference results instead of repeating their bodies. Worker final text is retained without the former 1,024/8,192-character cuts, up to the managed-turn limit of 256 KiB; larger output fails explicitly rather than being silently shortened. State events over their 64 KiB budget omit the result body and carry `resultAvailable`/`resultRef`; the authoritative task and attempt still retain it. Git diff previews remain explicitly marked with `diff.truncated` and are separate from worker final text.

Worker failures retain a bounded, redacted `failure` object (`code`, `message`, `observedAt`) on the task and attempt. Gateway shutdown is reported as `GATEWAY_SHUTDOWN`, rather than an unexplained issue failure. Task-specific `task_status` and current notification reports include this evidence and the latest eight tool activity entries (tool name, use/result, error flag and timestamp). Uncertain process outcomes remain `needs_reconciliation`; failure evidence does not authorize replaying side effects. Older failed tasks without stored evidence are not retroactively assigned a cause.

Managed Agent timeout diagnostics are emitted as `response.timeout` with `responseId`, `phase` (`startup`, `first_response`, `idle`, or `total`), `elapsedMs`, and `idleMs`. The existing `response.failed` event still closes a failed turn. `conversation.idleTimeoutMs` limits inactivity after inference starts; the legacy `decisionTimeoutMs: 15000` template value no longer overrides the 120000 default; startup/first-response budgets are separate and `maxDecisionDurationMs` remains a hard cap. Shorter API request deadlines remain enforced. No automatic replay of side effects is introduced.

Managed activity is based on durable input, decision and Worker states, including autonomous result turns. A completed Agent acknowledgement does not make a running Worker idle. Telegram/Discord/LINE typing renewal stops at idle or user-input/reconciliation waits; legacy file-heartbeat warnings and replay recovery are excluded for managed turns. API/voice retain their own request, process and transport deadlines.

Uploaded still images (PNG/JPEG/GIF/WebP) are supplied as native image content in the Agent's input turn before any task dispatch. Existing attachment upload and authorization rules are unchanged. The Agent can answer image questions directly; workers still inherit original attachment references for subsequent execution. Native image input is bounded to 5 MiB per image, 20 MiB and 20 images per turn. Unsupported, missing or over-limit images are identified to the Agent instead of silently treating a filename as visible image content.

Worker questions are presented by the Agent in natural separate messages. All ordinary replies, including platform Reply and voice transcripts, are interpreted before `task_answer` commits an answer. Consultation leaves work waiting. Contextual reminders require elapsed cooldown and new user messages; the Agent chooses whether they are useful, without reminder/mute buttons or recurring timer messages. Explicit answer commands and authenticated APIs remain available. See [task questions and reminders](./tasks.md#answer-a-task-question).

## Session activity {#session-activity}

`GET /api/v1/agents/:agentId/sessions/:sessionId/activity?after=0`

Requires an API key authorized for the Agent and the conversation principal. `after` is a non-negative event cursor; pass the previous response's `cursor` on the next poll. Invalid session IDs/cursor syntax return `400`; inaccessible activity returns `403`. The response contains current bounded task/response snapshots and incremental tool activity (at most 500 tool events per poll):

```json
{
  "cursor": 12,
  "busy": false,
  "tasks": [{
    "taskId": "<task-id>", "title": "Review change", "state": "completed",
    "stateVersion": 3, "result": "Review finished", "updatedAt": 1788760000000
  }],
  "responses": [{
    "id": "<response-id>", "requestId": null, "state": "completed",
    "text": "Review finished", "createdAt": 1788760000000, "files": []
  }],
  "tools": [{
    "seq": 12, "type": "tool_use", "id": "<tool-use-id>", "name": "Bash",
    "input": { "command": "npm test" }, "taskId": "<task-id>", "role": "worker"
  }]
}
```

Activity snapshots retain all non-terminal tasks plus the latest 100 terminal tasks, so newer completed work cannot hide an older running task. `/tasks` paginates active work and `/stop` selects cancellable work independently of terminal history.

Deduplicate responses by `id` and tool events by `seq`; snapshots are repeated across polls. Background responses may have `requestId: null`. `busy` describes the conversational Agent turn, so also inspect task states for running workers. `tool_result` events identify the call and may include `is_error`; this feed does not expose raw reasoning or complete tool-result bodies. Files use the existing media delivery API. Old events are pruned independently of task snapshots.

## Internal task dispatch {#internal-task-dispatch}

**Telegram tool status.** While managed work is active, its tool-status message moves to the bottom after six newer gateway-observed user messages or delivered replies in the same account/chat/topic, at most once per 30 seconds. The replacement is sent silently before the previous message is deleted. Failed replacement preserves the old message; failed deletion retains its ID for retry and blocks additional replacements. Synthetic task-report inputs do not count. This approximates chat activity, not the user's scroll position. Legacy mode is unchanged.

**Orchestration skills.** Agent catalogs combine gateway workspace/module/shared skills with metadata discovered from the installed Claude Code runtime through an initialization-only handshake (no model request). Native/bundled skills such as `/code-review` and their reported aliases run directly through the worker's `Skill` tool; gateway shared/workspace skills retain their supplied files/resources. Gateway definitions take precedence for the same name. Discovery is cached briefly and refreshed before routing, while workers check availability in their actual execution environment. App discovery runs inside the validated container without host fallback. If discovery fails, ordinary gateway skills remain available and the Agent must report incomplete discovery rather than inventing a missing-skill or MCP-inventory diagnosis.

The Agent's scoped MCP `task_spawn` tool takes `title`, `instructions`, `target_profile`, optional `context_refs`, and optional `continue_task_id`/`continuation_policy`. A new continuation defaults to `after_success`: it is queued durably and starts only after its predecessor completes successfully. Failed/cancelled predecessors cause `TASK_DEPENDENCY_FAILED` without starting the dependent worker. Explicit `after_terminal` is for authorized recovery/inspection after a terminal outcome; uncertain or still-running predecessors continue to block it. Existing persisted tasks without the policy retain their previous terminal-only behavior. Skill dispatch also uses the registered `skill_name`/`skill_args`; live-voice delegation requires a contextual `spoken_acknowledgement`. These are model-facing tool fields, **not additional fields on the public messages endpoint**.

A continuation must reference a task in the same conversation. The gateway derives the workstream, queues behind its unfinished work and resumes a compatible worker session when available. Receipts/status retain `taskId`, `workstreamId`, `continueTaskId` and, after assignment, `workerId`. Workers report progress, request input and stage files through attempt-scoped tools. A playback stop does not cancel a worker task. The internal bridge/tickets must not be exposed as a public host execution API.

Task command identity is scoped to the originating input rather than the temporary decision. After interruption, matching committed mutations return the original receipt even when inference produces a new tool-call ID. A conflicting mutation for an input that already committed commands returns `RECOVERY_COMMAND_CONFLICT`; inspect persisted task status and obtain a new user input before issuing new work. This is task-command deduplication, not a guarantee that arbitrary external connector side effects are idempotent.

Host orchestration Agents and host workers load enabled native connectors using the same configuration as legacy mode. Connector credentials are refreshed on each new managed subprocess; in-flight tasks are not restarted for connector changes. Read-only decisions, disabled tools, isolated workers and app containers do not receive host connectors. Channel token hot reload applies to subsequent delivery attempts, including file and speech transport.

## User task cancellation {#user-task-cancellation}

For orchestration-enabled API sessions, `POST /api/v1/agents/:agentId/sessions/:sessionId/stop` interrupts the Agent reply and returns `{ stopped, menuId, tasks: [{ taskId, title, state }], responseText }`. Render `responseText` as an assistant message. Sending `/stop` through the messages endpoint returns the same numbered question using the normal JSON/SSE reply contract. A subsequent numeric message selects from that frozen menu without inference; `0` dismisses it. Menus are bound to the authenticated principal and session, expire after five minutes, and are replaced by another `/stop` or dismissed by unrelated text. Task selection does not follow worker-slot reuse or list reordering. `cancel_requested` means stopping, not confirmed termination. Only the selected task is cancelled; completed side effects are not rolled back. Legacy `/stop` retains its existing response and behavior.

Telegram private chats get task buttons plus Dismiss. The receiver and gateway both gate the new control path on orchestration; stale callbacks cannot cancel tasks in another session or after mode changes.

Worker file sharing uses the same active-attempt path checks as file staging.
Pass the original absolute path inside the active task workspace, an authorized
input attachment, or this session's media directory. Do not copy files into the
agent-wide media root. The private task bridge returns `ARTIFACT_PATH_DENIED`
with a corrective `message` and `retryable: true`; retry only after correcting the
path. The MCP share client preserves the bridge error code (including stale or
unauthorized attempts) instead of replacing every error with `share_scope_denied`.
Files outside scope remain inaccessible and container boundaries are unchanged.

## Agent orchestration and voice configuration {#agent-orchestration-and-voice-configuration}

`gateway.orchestration` is `true` or `false` for all agents and channels. `agents[].orchestration` holds conversation/task/event tuning. All speech settings live directly at `agents[].voice`: `enabled`, `stt`, `tts`, `notes`, `language`, `turns`, and `playback`. No gateway voice defaults are inherited. New agents start disabled with no selected models. Voice requires both orchestration and the agent's voice switch; channel reply policy remains independently controlled by `/voice`.

Orchestration text delivery covers Telegram, Discord, LINE, Slack, WhatsApp (linked Baileys accounts and Cloud API), and WeChat. Linked channels reuse their running gateway transport; WhatsApp replies retain the receiving account in the durable binding. WhatsApp supports staged image/document delivery. WeChat currently supports text only; staged attachments report `CHANNEL_ATTACHMENTS_UNSUPPORTED`. WhatsApp and WeChat task/session menus use text commands (`/orch <token>`) instead of native buttons. Voice reply controls remain supported on Telegram, Discord, LINE and Slack; unsupported channels return an explicit notice.


Old object-form gateway settings and `agents[].orchestration.voice` are migrated once, preserving the effective values and explicit overrides in each agent before removing the old fields. Existing global task/conversation/event tuning is copied into each agent too. The migration is idempotent, preserves raw environment references, and coordinates with config writers. Provider API keys remain environment variables or upstream connector credentials.

## Discord, LINE and Slack orchestration controls {#discord-line-and-slack-orchestration-controls}

The global `gateway.orchestration` switch applies to all Agents and all connected channels. Per-Agent settings only override tuning; per-Agent `enabled` and `channels` are ignored. `/session` and `/sessions` are direct gateway controls on these orchestration channels and do not invoke the model.



Enable `gateway.orchestration` and configure the same `voice.notes` / `voice.tts` fields as Telegram. `/voice [on|auto|off]`, `/voices`, `/tasks` and `/stop` are intercepted before inference. Settings retain the existing tables with namespaced non-Telegram keys (`[channel, chatId]`); Telegram keys remain unchanged. This prevents preferences for identical IDs on different platforms from colliding. Preferences apply across threads in a chat; delivery retains the original thread binding.

Explicit audio shares serve MP3 and M4A inline with `Accept-Ranges: bytes`, single-range `206` responses and `Content-Range` for player probes/seeking. GET and HEAD retain the existing token, containment and MIME checks; document shares remain downloads.

LINE loading uses `POST /v2/bot/chat/loading/start` for 1:1 user IDs. Ingress starts the indicator before media download; the orchestration runtime renews it from durable input/decision/task state, every four seconds with five-second expiry. A newly delivered acknowledgement triggers renewal on the next one-second activity tick if work remains. Idle, user-input wait, reconciliation, global Off and shutdown stop renewals. Loading renewals and outgoing orchestration replies/menus are serialized per Agent/chat, so a late renewal cannot overtake the reply that clears it. Ingress awaits its initial loading request before forwarding any command. Queued renewals recheck activity before sending. LINE clears loading on outgoing messages, has no explicit stop endpoint, and only shows it while the user is viewing the 1:1 chat; groups/rooms are unsupported. See [LINE's loading API](https://developers.line.biz/en/reference/messaging-api/#display-a-loading-indicator).

Control tokens expire after five minutes and bind channel, chat, thread, session and principal. Replayed setting/cancellation selections, foreign users and session switches cannot reuse the token. Task views expose title/status/progress/question, not worker instructions, credentials or installed skill bodies. Discord and Slack edit the existing menu; LINE replaces quick replies with a new message and uses a valid reply token before push fallback.

| Ingress | Normalization and validation |
|---|---|
| Discord receiver | Native slash commands/buttons re-run the access gate. Audio attachments carry `attachment_kind: voice`; only Discord CDN references are downloaded. |
| `POST /webhooks/line/:agentId` | Existing signed JSON route handles audio blobs and scoped control postbacks. Postbacks re-run the current source access policy. |
| `POST /webhooks/slack/:agentId` | Accepts signed JSON Events and signed URL-encoded slash-command / `block_actions` bodies. Audio downloads require HTTPS Slack hosts, bounded bytes and no credential-bearing redirects. |

Slack app registration remains an external setup step: point Slash Commands and Interactivity at the same webhook URL, enable `commands`, `files:read`, `files:write` alongside existing messaging scopes, and reinstall after scope changes. The bot token does not administer Slack autocomplete registrations, so disabled orchestration rejects stale commands but cannot remove them from Slack’s app settings. See [Slack slash commands](https://docs.slack.dev/interactivity/implementing-slash-commands/) and [interaction payloads](https://docs.slack.dev/interactivity/handling-user-interaction/). Native slash commands are unavailable inside Slack threads; `@bot /command` messages preserve the thread context.

Speech uses a bounded MP3 file pinned to the selected provider/voice/model. Discord uploads an audio attachment; Slack uses [external file upload](https://docs.slack.dev/messaging/working-with-files/) and completes it in the original thread; LINE sends an [audio message](https://developers.line.biz/en/reference/messaging-api/#audio-message) after converting provider MP3 to AAC-LC mono 44.1 kHz M4A with fast-start metadata. This requires `ffmpeg` and `ffprobe` in the gateway host PATH; conversion errors produce `LINE_AUDIO_CONVERSION_FAILED` and retain the text response. Duration comes from the converted file. The 30-minute share URL ends in `/audio.m4a`; public fetches revalidate it and serve `audio/mp4` with `nosniff` (older MP3 shares retain `audio/mpeg`); ordinary `any` shares remain image/PDF-only. Turning voice Off suppresses synthesis and pending delivery; already accepted sends cannot be recalled.

## Dashboard and retention {#dashboard-and-retention}

Dashboard Conversations include retained managed sessions from previous gateway runs. Lists are paginated at 25 sessions per agent; reading them never starts a session or worker. Empty token fields mean instrumentation was not recorded, not zero usage.

`GET /status` retains legacy sessions and includes managed sessions in `agents[].sessions`, marked `orchestration: true`. Managed rows carry `status` (`thinking`, `working`, `queued`, `waiting_input`, `needs_reconciliation` or `idle`), nested `tasks` and `workerIds`. `agents[].orchestration` includes `agentProcesses`, task summaries and `workerPool` (`maxWorkers`, `idleTtlMs`, `workers`). Worker records expose worker/session/workstream IDs, busy/idle state and idle `expiresAt`. Task summaries expose predecessor, worker session, resume status, active host PID and latest tool. A container PID here is the host Docker client PID. Finished tasks do not claim a stale PID is still running.

`/dashboard` displays managed and legacy sessions together; opening a managed session shows its assignments, recorded turns and worker attempts. Task details identify the exact worker session and attempt; task totals include recorded retries while the latest-attempt column does not. Headless sessions have no interactive PTY viewer. The direct path is `/dashboard`; `/gateway/dashboard` requires a reverse-proxy prefix.

Worker idle expiry (default 10 minutes) retires a pool slot, not the task. Task records in the per-agent `orchestration.db` have **no automatic deletion policy yet**. Event/tool activity defaults to seven-day retention. Eligible private task workspaces are archived separately after seven days by default; host/container user files are excluded. Existing chat-history retention does not delete task records.


## Channel ingress recovery {#channel-ingress-recovery}

The internal loopback `POST /channel` callback accepts receiver envelopes shaped as `{content: string, meta: Record<string, string>}`. For orchestration messages, `200` means admission was committed to SQLite before acknowledgment. Scoped provider message IDs and the original envelope fingerprint deduplicate redelivery before downloading attachments again. This callback is internal to channel receivers, not a public messages API.

Permanent attachment failures (including provider rejection, missing files and size limits) preserve the caption/text and any readable attachments, record which direct or quoted attachments were unavailable, and enqueue one notice per admitted message. The Agent receives that unavailable status and must not claim to have read those files. Voice-note transcription requires the original direct attachment to be available; a readable quoted recording cannot become the new voice request. Attachment admission currently limits Telegram files to 20 MiB and Discord files to 50 MiB; known sizes are checked before download and streams are bounded independently. These are gateway limits, not promises about provider upload limits.

Network errors, HTTP 408/429 and provider 5xx responses reject admission for retry. The callback returns `429` for a provider rate limit, otherwise `503`, with a safe `{accepted: false, code, retryable}` diagnostic and `Retry-After` when available. Malformed callback JSON returns `400`. Provider URLs, credentials and raw error bodies are not included in diagnostics.

Telegram and Discord receiver journals persist exponential retry delays from one second to five minutes, honoring longer `Retry-After` delays up to 24 hours. A failed conversation preserves its own order while other conversations continue. Telegram albums retain their collection quiet window. Once a batch is attempted, its payload is frozen; later album members are separate batches under their own message IDs. Acknowledged album member receipts are retained for up to 24 hours (latest 1,000); pending payloads and retry state never expire through this cleanup. Retry state survives restart; payloads remain on disk until acknowledged.

At receiver startup, if any persisted entry in a conversation is older than five minutes, its entire startup queue is marked for recovery. The gateway saves the original text and metadata, marks those inputs handled, and sends one recovery notice for the batch. **It does not execute queued commands, start inference, or dispatch tasks for these entries.** History labels recovered text as not executed; original attachment references are retained in the durable input metadata, but expired remote file contents cannot be recovered automatically. Resend the requests and files that are still needed. Fresh arrivals are admitted normally, and previously admitted messages remain deduplicated even if their acknowledgment was lost. If an envelope conflicts with its existing receipt, including an older album expanded after admission, it is archived separately under a stable recovery identity with one notice per original message. It cannot change or re-execute the already admitted request.

Unreadable journal records are retained for operator inspection with a bounded diagnostic. Invalid album member metadata and damaged retry records block only their identifiable conversation until repaired; it does not silently discard messages or block other conversations.

## Session token reports {#session-token-reports}

- `GET /dashboard/token-report?agentId=AGENT_ID&sessionId=SESSION_ID` renders the English HTML report.
- `GET /token-report?agentId=AGENT_ID&sessionId=SESSION_ID` returns its JSON data.

Reports show newest turns first, 25 at a time (`offset=0`, `offset=25`, and so on). The HTML report defaults to `scope=24h`: today from 00:00 UTC. The toggle supports `24h`, `7d`, `30d`, `90d`, and `all`; multi-day windows include today and start at midnight UTC. The JSON endpoint keeps its all-history default when no scope is supplied. Totals and distribution cover every turn in the selected scope, not just the current page.

When API keys are configured, the HTML report requires a live dashboard session cookie, exactly like the dashboard page. An API key injected by a reverse proxy does not bypass this login; visitors without a valid cookie are redirected to the dashboard login before any report is read. The JSON route accepts either a dashboard session or an admin API key for programmatic clients. Keyless installations retain the existing loopback/local-access policy. An ordinary agent-scoped API key does not grant access. Responses use `Cache-Control: no-store`. A reverse-proxy prefix such as `/gateway` must be applied consistently to the dashboard and these routes.

The report separates user-input handling, Agent reporting turns and worker attempts. It contains available per-request and per-turn input, cache-creation, cache-read and output counts, tool inventories and actual tool calls, plus corresponding task/input/result context. Background learning is excluded from the conversation report. Request IDs deduplicate repeated stream/content-block usage; CLI aggregate usage is reconciled with the request breakdown rather than counted twice. Thinking is part of output. Percentages are token volume, not provider billing.

The durable `token_turns` ledger starts recording after deployment; it does not reconstruct earlier usage. Unknown or incomplete measurements are explicitly identified. This report can contain conversation and task content and must remain behind the administrative gate.

## Dashboard data and live updates

- `GET /status?offset=0` returns a snapshot, including retained session pagination, task counts, and recorded token activity for the current UTC day.
- `GET /dashboard/events?offset=0` streams `snapshot` events with event IDs. Reconnecting receives a fresh snapshot; `Last-Event-ID` can suppress an unchanged snapshot. This is a snapshot stream, not a durable event-log replay.
- `GET /dashboard/session?agentId=AGENT_ID&sessionId=SESSION_ID&offset=0` returns session metadata, up to 50 tasks and 50 recorded turns. These lists have independent totals; their common offset advances each list by 50.
- `GET /dashboard/task?agentId=AGENT_ID&sessionId=SESSION_ID&taskId=TASK_ID&offset=0` returns the assignment, latest result and up to 25 attempts with their own token measurements and latest 30 recorded events. The task must belong to the requested session.

These routes require the same admin credentials as `/status`, return `Cache-Control: no-store`, and never accept filesystem paths from callers. Gateway-owned paths are read with read-only SQLite connections on a dedicated worker thread. A bounded request queue, coalesced reads and short snapshot caches isolate database work from chat delivery. New token measurements maintain a small projection alongside the ledger atomically; older ledger entries remain readable without a synchronous startup backfill. Details load on demand. Hidden browser tabs disconnect their live stream, and slow clients do not accumulate unlimited snapshots. Process diagnostics load only on the System view.

The dashboard and login use the same local pastel theme and bundled Poppins font. Login still exchanges an **admin API key** for the existing HttpOnly session cookie; scoped agent keys cannot access cross-agent monitoring. Font assets are public static files and contain no gateway information.

Dashboard views default to `24h` and share the calendar-range toggle across snapshots, live streams, details and reports. Session/task lists use latest activity within the window; token totals use turns started within it. The previous `current` query value falls back to today. The cutoff advances at UTC midnight even for an open live stream. The gateway supplies the cutoff, not the browser. Agent badges and channel icons are shared across views, and tables keep fixed column widths with horizontal scrolling when needed.

Session token reports refresh visible data every five seconds while the tab is visible, preserving filters, expanded turn details and theme. Provider usage is broken down by role into input, cache write, cache read and output across the selected scope. Context bootstrap is a separate estimate: the `cl100k_base` reference tokenizer measures current generated workspace sections, source files and host Agent gateway tool schemas in the reader thread, cached for 30 seconds. It is not the selected model's exact tokenizer or historical usage attribution. Source files and sections must not be added to the parent CLAUDE.md total. Conversation history, runtime overlays, native CLI instructions/tools and provider framing are excluded; container-only workspaces and unreadable/oversized files remain unavailable. No model requests are made for this measurement.

Dashboard rows open session/task/turn detail drawers on click (Enter/Space also work), preserving the selected record across refresh. Session IDs are displayed in full. Missing values render as —. **Used** counts distinct observed tool names, not calls. The legacy JSON `loadedTools` field is the inventory reported by CLI `system.init`, not proof of model-context loading. **Loaded** uses `contextTools`: distinct schemas observed in captured outbound requests, including referenced deferred tools. Schema coverage identifies measured versus observed requests; uncaptured turns remain —. Raw capture files are temporary and private; retained telemetry contains tool names only. Failed agent turns include a recorded response failure code where available; a failed report turn does not imply a failed worker.

The Context window card uses the latest observed request in the newest agent turn, including output, rather than the pre-compaction peak. Capacity resolves from the agent model catalog and configured models; unknown capacity remains null/— rather than an assumed 200K. This is the latest recorded request measurement, not an exact live tokenizer reading. Auto-refresh updates the session header status, model-filter choices, totals and turn rows. A selected model remains selected even when it no longer has rows on the current page.

## Overview chart measurements

`GET /dashboard/charts?scope=24h` requires an admin API key or dashboard login. Accepted ranges are `24h`, `7d`, `30d`, and `90d`; unsupported or repeated range values return `400`. The response has `Cache-Control: no-store`.

The response contains `scope`, configured `timezone`, `since`, `asOf` (a snapshot timestamp rounded down to 10 seconds), and `agents`. Each agent includes:

| Field | Meaning |
| --- | --- |
| `id` | Agent identifier |
| `agent`, `worker` | Total recorded tokens by role |
| `buckets` | `{key, agent, worker, fresh, write, read}`; input breakdown fields include only measured turns, matching `reuse`; local hour `00`–`23` for today or `YYYY-MM-DD` for longer ranges |
| `models` | `{name, tokens}` sorted by recorded volume |
| `reuse` | `fresh`, `write`, `read`, `measuredTurns`, `missingTurns` |

Input reuse is `read / (fresh + write + read)`; missing breakdowns are excluded, not replaced with zeros. All totals use one latest measurement per recorded turn, attributed to its start time. These are token volumes, not billing charges. The read worker coalesces requests for the same range and snapshot; it does not read full transcripts on the gateway event loop or request new provider measurements. A temporary reader failure returns `503` rather than a partial total.
