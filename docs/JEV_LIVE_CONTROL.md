
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
action at a time, without another Jev decision, for one decision before returning to Jev; three further
consecutive non-progress results yield to the controller. A new command resets to Jev. See the loop's
`action-thinking` module for the provider-independent decision contract.

Computer scroll/back/forward are capability-negotiated by each observation; an
older connector remains usable but cannot offer these additional actions. These
changes do not grant coordinate, shell, or unapproved-application access.

## Agent control and user control

User control is the default for new Browser Use and Computer Use sessions. Commands go directly to the task; the conversational agent does not intervene. Users can explicitly switch to Agent control. In Agent control, each confirmed action yields fresh evidence and a
scoped notification. The conversational agent inspects the screenshot and sends
one next instruction on the same task; it is the operator, not only a verifier.
The overall user objective stays in conversation; each loop command is one step.
Thinking supplies one fallback action after three no-progress attempts, then
returns to Jev; repeated non-progress yields to the controller.

The authenticated task control endpoint accepts `action: agent | user` to switch
the controller without executing/replaying an action. User control disables
automatic agent continuation and uses the same text/voice execution destination.
An in-flight operation still settles before further work; switching controllers
never removes unknown-operation fences. Idle is not a success claim.

## Validation checkpoint — 2026-09-24

- Loop: 128 tests pass, including a single Thinking fallback, one-action slices,
  post-action evidence, waiting after repeated blocking, and mutation fences.
- Gateway: 82 task/control tests plus 7 mailbox tests pass. The mailbox regression
  checks that agent control can wake without another user message and user control
  disables that automatic wake path.
- Web: Agent is the default; switching controller is acknowledged by the gateway
  before changing text/voice destination. Rejected switches retain the old mode.
- Live flight test was accepted and the parent created a scoped step to navigate
  to the initial flights page and inspect it. Execution has not begun: the browser
  device was offline (online=false, ready=false); permanent consent still exists.
  This is NOT a completed browser E2E test or proof of autonomous completion.
- Required live sequence remains: fresh Bangkok–Tokyo round trip, 3 adults and
  2 children, 25–26 Sep 2026; product search/category/price/cart (no checkout);
  school search and map zoom both ways; private synthetic spreadsheet with SUM,
  edits and AVERAGE. Run sequentially after the browser reconnects.
- Every live case must record the observed result, task/revision and intervention
  count. Agent continuation alone is not independent proof of task success.

## Live validation — 2026-09-25

### Flight search: passed through visible results (no booking)

Gateway `85c43db`, loop `b5277c0`, web `71558dea`. Started at the
Google Flights home page; the parent supplied instructions through 17 revisions
on one authorized browser task. Recorded observations show Bangkok BKK to Tokyo
NRT, economy, departure 2026-09-25 and return 2026-09-26. Passenger-dialog
observations in revisions 13–15 show adults at 3 and children increasing 0→1→2.
The parent independently requested a fresh screenshot after Search; its tool
result at 02:24:05 UTC reports 8 results returned. No booking was performed.

Setup required closing an old test that still held the target and rediscovering
the tab after reapproval changed its ID. There were no operator-supplied form
steps during the 17-revision run. However, the parent tried to issue an extra
step under an old notification and received EXECUTION_DENIED. Commit `7193b87`
adds an explicit end-turn handoff after dispatch; authority remains scoped to
the next notification. It was deployed after the flight case, before Shopee.
This run does not prove that the handoff fix itself has passed all live cases.

The web at the test tunnel displayed Agent control (Auto) as the default and
the existing task as the User control destination, without a page error.
Shopee, Maps and Sheets remain pending at this checkpoint.

### User control recovery

User-controlled sessions do not expire due to Gateway idle time; explicit Stop
closes them. Device consent can still be revoked or expire independently. Task
notifications never wake the conversational agent while user control is selected,
including failure notifications. Known helper exits/timeouts before a mutation
allow a new command on the same task; unknown operations remain fenced and cannot
be replayed. Access denial reports describe the relay state without claiming that
a new popup was declined or that macOS Screen Recording permission is missing.
