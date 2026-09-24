
## Continuous commands and visual takeover

Explicit `execution_task_id` inputs (text or transcribed voice) go directly to the
owned browser/computer task. The input and deterministic control receipt are
committed together; no conversational-agent inference is scheduled, including
after a gateway restart. The selected session must belong to the same principal
and conversation. Closed sessions and uncertain previous mutations stay fenced.

After a command settles, the session can stay `idle`/`waiting_input`. The next
command reuses its task identity and starts from a fresh observation, without
replaying earlier completed requirements. A completion candidate is not claimed
as verified success. Selecting Agent returns to normal conversation.

With `gateway.jev.thinking` configured (or a browser text-helper override), three
consecutive attempts without observed progress activate visual Thinking takeover.
It receives the original/current command, recent outcomes, supported actions and
a fresh approved screenshot. It answers multiple independent choice questions in
one call using request-local numeric option IDs. Only typing may include literal
text. Extra prose or unknown options are rejected. Thinking executes one guarded
action at a time, without another Jev decision, for at most eight decisions/three
consecutive non-progress results. A new command resets to Jev. See the loop's
`action-thinking` module for the provider-independent decision contract.

Computer scroll/back/forward are capability-negotiated by each observation; an
older connector remains usable but cannot offer these additional actions. These
changes do not grant coordinate, shell, or unapproved-application access.
