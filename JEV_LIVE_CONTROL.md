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

## Client integration boundary

This is the backend prototype. Ordinary chat messages and voice transcripts are
not automatically routed here. A client must explicitly target the active task;
finalized speech can use the same `revise` payload. For voice interruption, send
`pause` at the chosen speech boundary, then `revise` with confirmed text (or
`resume` if the speech was discarded). Do not submit interim STT fragments as
successive corrections. Show pending/paused/applied status from task state.
Natural-language routing, Web Chat controls and spoken acknowledgements still
need client integration and live browser/voice E2E validation.

## Tests

Jev Loop covers interruption during inference, field resolution, desktop thinking
and a dispatched mutation (confirmed versus unknown). Gateway lifecycle tests
cover same-task corrections, retained constraints, no repeated start navigation,
pause/resume, multiple corrections, duplicate command IDs, stale revisions,
principal isolation and unknown-outcome fencing. These tests are not evidence of
live Web Chat or voice integration.
