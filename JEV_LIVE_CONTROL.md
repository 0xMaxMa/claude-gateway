# Live execution control prototype

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
- Revise appends a correction that supersedes conflicting requirements, retains
  the remaining goal, and starts a fresh observation on the same task after the
  previous attempt settles. Earlier field answers become context rather than
  unconditional text overrides.
- Resume is valid only for a task paused through this interface.
- Unknown mutation outcomes and interrupted processes require reconciliation;
  they cannot be resumed through this endpoint. No uncertain action is replayed.
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
revision or schedule an orchestrator decision. Unsupported states produce a
visible notice and never fall back to starting unrelated work.

The voice WebSocket accepts `execution_task_id` (or null) in `voice.start` and
`voice.configure`. Confirmed STT words pause the selected task. Microphone noise
alone does not pause it. The target stays fixed across the current spoken
message even if the UI selection changes. Final speech becomes one correction,
with a canonical response ID and a TTS acknowledgement. Discarded speech leaves
the task paused for explicit resume.

GetPod Web Chat exposes the selected task, Pause/Resume, pending status and an
Agent conversation option. A single active Browser/Computer task is selected
initially; multiple tasks require an explicit choice. Selection is scoped to the
current gateway/agent/session and does not persist a cross-session global target.

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
