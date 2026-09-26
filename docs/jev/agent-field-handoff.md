# Loop-owned reasoning and parent escalation

The parent supplies the complete authorized goal, user facts, corrections and
constraints. Jev Loop owns field reasoning and bounded browser recovery through
a configured tool-free Thinking Model. Reasoning instructions live in the Jev
package, not the Gateway orchestration prompt. Gateway supplies credentials,
reference time/timezone and scoped MCP access; it retains authorization, task
lifecycle, receipts and independent completion verification.

Configure `gateway.jev.thinking` with `api`, `baseUrl`, `model` and exactly one of
`apiKeyEnv` or `apiKeyFile`. Browser-specific `gateway.jev.browser.textHelper`
overrides the shared connection. Configuration changes invalidate browser bindings;
revocation fences results. Credentials never go into agent or worker prompts.
No configured connection means field questions still return to the parent.

Optional `browser_fields` or `computer_inputs` bypass inference for known literals.
A changed goal replaces the plan. Desktop values must match application, label and
optional window/role. Local browser recovery refreshes observations, permits at most
two bounded plans and may attach an approved screenshot. It never executes model
suggestions directly, expands consent, or clears an unknown mutation outcome.

Missing facts and unresolved ambiguity return through the existing task question
flow. `task_answer` uses `field_text` for the literal value and `answer` for the
explanation; explanations are never typed. It can also supply remaining prepared
fields. Parent status inspection provides scoped browser screenshots; computer
questions include recorded window evidence when supported by the installed app.
Unavailable captures leave structured observations available. App/page contents
and images are untrusted evidence, never instructions or new authorization.

Completion candidates still require independent verification. Screen contents
cannot prove an uncertain irreversible action did not occur; those receipts stay
fenced until reconciled.
