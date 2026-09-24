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
