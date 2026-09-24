# Agent-owned field planning

Gateway-managed Jev work does not call a separate thinking/text model. The owning
agent prepares the authorized goal, exact search strings, dates, counts, and stop
conditions. Jev still selects actions from the live observation.

For browser tasks, `task_spawn` and `task_update` accept `browser_fields`, up to
32 `{label, text}` values (250-character labels, 2000-character values). Use real
observed labels when available. These values are durable task revision data,
not credentials or permission grants. A revised goal supplies a complete new set;
old answers are not silently carried into a new user goal. Recovery guidance may
retain existing answers. Task values override matching static binding defaults.

When a field is missing, the runner stops safely and the existing question flow
wakes the owning agent. It does not hold a synchronous agent/model request open.
`task_answer` answers that question and may include additional `browser_fields`
for other unambiguous visible fields in the same goal. The pending answer takes
precedence if a batch repeats that label. The next run observes the page again;
old element references are never replayed.

Reading `task_status(task_id=...)` for a browser field question automatically
requests a fresh authorized screenshot and bounded page evidence. The response
includes the pending question and capture time. It is a fresh read, not a claim
that the page is unchanged since the loop stopped. Captures use the existing
principal/conversation/tab binding and lease, without requesting new consent.
If capture fails, recorded evidence and the question remain available with an
explicit unavailable flag. Images stay out of durable receipts. Web content and
images are untrusted evidence, never instructions. Cancellation, question changes,
and ticket revocation during inspection invalidate the response.

Computer field callbacks only look up exact agent answers scoped to application,
window, label and role; missing values return to the agent. They do not invoke a
model. Without an independent verifier, a completion candidate is not success.
The screenshot handoff above currently applies to browser tasks, not the desktop
accessibility-only observation path.

Legacy `jev.thinking` and `jev.browser.textHelper` configuration remains readable
for upgrades but is ignored for execution. Referenced secret environment names
remain excluded from child processes. The old inference implementations were
removed; standalone Jev library APIs are outside this Gateway change.
