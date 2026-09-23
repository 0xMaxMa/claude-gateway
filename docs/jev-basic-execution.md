# Jev basic execution and browser diagnostics

This change depends on Jev Loop 0.4, pinned by immutable commit. Browser and
Computer Use no longer instantiate an Experience Library or read/write/download
packs. Remove the obsolete `gateway.jev.experience` key before upgrading; config
validation rejects it rather than silently retaining a nonfunctional setting.
Old private experience cache files are inert. This change does not delete user
files, modify a running installation, or deploy a registry service.

Browser tasks store bounded structural trace events in their private durable
receipts. An authorized parent reads them via the existing `task_status` browser
evidence option. The same agent/principal/conversation authorization still applies.
Traces survive a host restart and remain available when execution is interrupted.
The separate synchronous pre-mutation checkpoint remains the recovery authority.

Events distinguish dispatch, confirmed/not-executed/unknown action outcome,
observed effect and runner verification. A confirmed action is not whole-task
success; absence of an effect is not a verified failure. Parent verification
committed after execution is reflected in task state, not retroactively inferred
from earlier trace events. Check both the current task state and evidence.
`truncated`/`sinkFailed` flag incomplete telemetry. Events exclude page text,
labels and entered values; full browser observations already present in scoped
evidence remain private and should not be published as diagnostic logs.

The loop passes recent target/value/outcome context only to authorized inference.
Stale recovery resets its consecutive budget after observed progress and never
replays uncertain mutations. The field helper is instructed to extract explicit
goal values across differing UI languages. Missing or ambiguous facts still
hand back to the parent. `NO_SUPPORTED_ACTION` and legacy `MODEL_BLOCKED` do not
prove CAPTCHA, provider refusal or website anti-automation blocking.

## Deployment acceptance

Before claiming real-site success, run Gateway -> Jev Loop -> MCP -> extension
against an approved browser tab. Check flight origin, destination, trip type,
date, adult count and cabin in visible results. Use a future date as a separate
control when reproducing an example with a past date. Cover stale autocomplete,
calendar repaint, field handoff, cancellation, revoked consent and unknown
mutation outcome without replay. Unit/adapter fixtures are not real-site proof.
