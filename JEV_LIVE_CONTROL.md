# Live execution control

Browser and Computer Use tasks accept authenticated controls without an inference
turn or another task. The existing Gateway task remains the durable owner.

`POST /api/v1/agents/:agentId/sessions/:sessionId/tasks/:taskId/control`

```json
{
  "id": "a newly generated UUID for this command",
  "action": "revise",
  "expectedRevision": 1,
  "text": "Use Manchester instead of London. Keep the passenger counts."
}
```

Actions: `pause`, `revise`, `resume`. Only `revise` accepts text. Read the task's
current revision first. Reuse the same command ID and identical body after a
transport timeout; a duplicate is not applied twice. HTTP 409 means the task or
revision changed: read its state before making another decision. Authorization
uses the existing API principal, conversation membership, task owner and tool
permission. Model-provided task IDs never grant access.

- Pause stops new decisions and mutations, then waits for an already dispatched
  operation to settle. It does not undo that operation.
- Revise prepends the latest correction that supersedes conflicting requirements, retains
  the remaining goal, and starts a fresh observation on the same task after the
  previous attempt settles. Earlier field answers become context rather than
  unconditional text overrides.
- Resume is valid only for a task paused through this interface.
- Unknown mutation outcomes and interrupted processes require reconciliation;
  they cannot be resumed through this endpoint. After an explicit user request,
  the agent can inspect fresh scoped evidence and use `reconcile_browser`. This
  requires settled operation status, or a recorded legacy TYPE_TEXT stale
  rejection before keys/text were dispatched. Timeout/disconnect and unresolved
  mutations remain fenced. A new revision observes the current page; the old
  operation ID is never replayed.
- `executionControl.phase` distinguishes accepted/pending, applied, paused and
  blocked. A 202 response acknowledges acceptance, not completed interruption.
  Existing task events and receipts continue carrying progress/results.

The runner receives a separate `interruptSignal`. Inference and text helpers can
be interrupted without cancelling an in-flight browser/desktop mutation. The
normal execution signal still governs cancellation, timeout and revoked access.
An obsolete inference result cannot authorize another mutation. Corrections are
serialized by revision; only one execution attempt is active for a task.

## Web and voice integration

Chat message admission and streaming accept `execution_task_id`. Only an explicit
client selection uses this path. The task must belong to the authenticated
principal and the same conversation/session. The input, correction and response
receipt commit together; replaying a client message does not append another
revision. The canonical input remains pending for one agent-authored response.
Applied controls give the response turn read-only execution capabilities; the
agent cannot send the correction twice. Rejected controls go to the agent with
a durable, scoped reason for inspection and continuation of the same task.

The voice WebSocket accepts `execution_task_id` (or null) in `voice.start` and
`voice.configure`. Confirmed STT words pause the selected task. Microphone noise
alone does not pause it. The target stays fixed across the current spoken
message even if the UI selection changes. Final speech becomes one correction,
with a canonical response ID and the agent response streamed into TTS. Discarded speech leaves
the task paused for explicit resume.

GetPod Web Chat exposes the selected task, Pause/Resume, pending status and an
Agent conversation option. A single active Browser/Computer task is selected
initially; multiple tasks require an explicit choice. Selection is scoped to the
current gateway/agent/session and does not persist a cross-session global target.
A selected task that ends remains selected until explicitly changed, preventing
a drafted correction from silently becoming a new agent request. Hydrated task
status and notifications include `currentInstructions` so parent verification
uses the corrected goal instead of the original conversation or task title.

## Validation

- Gateway tests cover input idempotence, ownership, same-session scope, retained
  requirements, pause/resume and uncertain mutation fencing.
- A real WebSocket test exercises confirmed partial speech, pause, a mid-speech
  selection change, final admission and TTS audio frames (fixture STT/TTS).
- Chromium + the real remote-browser extension + MCP + the live Jev provider
  passed a correction from London to Manchester. Old inference was deliberately
  held open to exercise interruption. Pause settled in 61 ms in this fixture;
  this is not a production latency guarantee. The field was filled once, fresh
  evidence verified it, and the same task completed at revision 3.
- The optional `scripts/jev-live-control-browser.cjs` harness receives an isolated
  browser fixture and reads a credential file without logging its contents.
  Field text is a controlled fixture value; Jev chooses the browser actions.

Live provider outages or a browser mutation already in progress can delay
settlement. Controls never promise to undo an action that already reached the
page, and an uncertain outcome continues to require inspection.

## Computer Use integration

Voice is transcribed by Gateway, not by the Mac app or relay. The same selected
`execution_task_id` routes confirmed speech to a Computer Use task. No microphone
permission or speech provider credential is needed in the desktop app.

Computer controls interrupt pending owner-approval waits and model verification,
as well as decisions and Thinking. An already dispatched desktop action still
settles before the corrected revision starts; unknown results block continuation.
A correction may recover a stopped computer task only for confirmed
`NO_SUPPORTED_ACTION` or `ACTION_BUDGET` results. Permission failures, unknown
mutations and interrupted executions do not use this shortcut.

The Mac reader reports focused controls. Computer Logic uses focus, fresh state
and recent observed action effects to choose the next action, including Enter when
the goal actually requires submission. Two ineffective repetitions on an identical
observed state remove that candidate until the state changes. This is ephemeral
within-run feedback, not an experience pack or a claim that a dispatched action
achieved the goal.

Computer rounds are persisted to scoped request receipts (up to 2,000 structural
events). Task status, dashboard details and channel task details show current
phase/evaluation counts; the snapshot includes only the latest 12 events.
`task_status({task_id, computer_trace_offset:0})` returns recorded pages of 40 events
in `computerTrace`. Follow `nextOffset`. It never makes a fresh observation,
invalidates a generation, or dispatches actions. Ownership and conversation
membership apply to host and container agents, including after ticket revocation.
Typed text and page/window contents are not included in this trace. Old requests
without recorded events report `available:false`; their history is not reconstructed.

### Computer receipt recovery

Unknown desktop outcomes remain fenced. The computer adapter polls scoped recorded
receipts every 15 seconds while a task needs reconciliation, including after gateway
restart. A matching completed/not-executed operation permits a fresh observation in
a new attempt of the same task; the original operation is never resent. Pending
blocked live controls do not silently resume. Local Mac owner acknowledgement ends
previous work as cancelled and preserves unknown rather than claiming completion.
Connector removal, grant revocation and conversation membership checks also apply
to receipt reads. The activity API includes `computerRecovery` guidance for this
state; clients should show where the owner can review it instead of a bare error.
## Continuing automation sessions

Browser and computer tasks now have `automationSession` alongside the existing per-round `state` and attempt history. Successful and settled failed rounds become `idle`; their success/failure evidence remains available. Uncertain effects remain `blocked` and require fresh scoped reconciliation. No inference loop or lease is held while idle.

An input targeting idle automation is interpreted by the parent agent. Questions get an agent response; a next goal uses `task_update` with the same task ID, current revision and the complete next goal. Completed instructions are not concatenated or replayed. A new dispatch acquires fresh authorization/ownership and observation; the original start URL is not replayed. Duplicate `task_spawn` for an open binding returns the existing task ID with continuation guidance.

`task_cancel`/the authenticated cancel API explicitly ends the automation session, including while the last round is already completed or failed. Closing a session does not change a stored successful round into a failed round. Active cancellation still waits for stop confirmation; a closed conversation is not evidence that an uncertain mutation was rolled back.

`orchestration.tasks.automationIdleTimeoutMs` defaults to 30 minutes. Idle/blocked/waiting periods carry a persisted timestamp. Expiry is evaluated on reads and before new commands, including after restart, without a polling agent or extending expiry on page refresh. Closed sessions require renewed user authorization for new work; they do not replay old operations. Existing browser/computer tasks are projected using their last recorded update, so upgrades do not silently grant another full idle interval.

Web clients should retain open automation entries and selection after a round ends, show `idle` without a typing indicator, and offer explicit End automation. A selected closed task remains visible as closed until the user changes destination, so drafted input is never silently redirected.

### Inspecting a stalled browser task

`task_status(task_id, browser_evidence="fresh")` returns bounded page evidence,
recent trace events and verification arguments before the page payload. The
current task instructions remain available; truncated evidence is explicitly
marked and is not complete proof. Full receipts remain available through the
existing evidence API.

Use `browser_evidence="screenshot"` when text alone is insufficient. The parent
receives an MCP PNG image and the same scoped evidence IDs. Inspection acquires
the existing approved-tab lease, checks authorization after capture and releases
the lease. It does not reopen consent, run browser mutations, or store screenshots
in receipts. Host and app agents receive the image through their task bridge.

The Jev browser chooser still uses structured DOM observations, not image input.
The parent can inspect the screenshot and revise the same task with concrete
recovery guidance. Repeated identical field replacements are excluded temporarily
from the offered text targets; other observed actions remain available. This is
not a website-specific script or proof of task completion.


## Computer window evidence and prepared field values

Computer tasks can read `task_status` with `computer_evidence: recorded`, `fresh`, or `screenshot`. Recorded evidence includes its observation time and must not be presented as a live screen. Fresh reads require existing local approval; they never grant access. A running loop owns the lease, so concurrent inspection returns its recorded evidence rather than disturbing the loop. Screenshot reads capture only the approved foreground window, using ScreenCaptureKit on macOS 14+. Screen Recording permission is required; system audio is not captured.

When a field needs input, the loop records the current accessibility state and, when available, a window image. The parent agent receives this scoped image on the question/report turn. App content is untrusted evidence, not instructions. The agent answers from the original request and must not send the user back to perform the requested typing/search. Only missing personal facts, actual OS consent, or unknown prior action outcomes require owner input.

`task_spawn`, `task_update`, and `task_answer` accept `computer_inputs` for computer tasks:

```json
[{"application":"com.apple.Maps","label":"Search","role":"AXTextField","text":"Bangkok"}]
```

The agent prepares literal values once. The loop uses one only when the current app and unique field label/role match; it never guesses a different target. `windowTitle` may further restrict the match. A new goal update replaces the plan, so stale values cannot leak into the next task. A field answer can include the remaining input plan in the same call. Unmatched/missing values go back to the parent agent, not a separate Thinking provider.

A completion candidate is not a completed task. The parent inspects fresh UI/image evidence and calls `task_update mode=verify_computer` with the returned request/evidence IDs and concrete findings. Evidence is scoped to the owner, conversation, request and revision, expires after 60 seconds, and cannot clear an unknown mutation. The same authorized failed round may be replanned by its assigned notification up to three times; mutation uncertainty remains fenced.

Screenshots are bounded JPEGs, retained only with the task's private request receipt, never inserted into structural progress traces. Old app versions still supply accessibility evidence but cannot capture an image; upgrade the app and relay together to enable `computer_screenshot`.
