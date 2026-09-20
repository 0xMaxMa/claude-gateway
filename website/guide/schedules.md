# Schedules and heartbeats

Use `HEARTBEAT.md` for workspace-defined proactive behavior. Use the cron API or CLI when you need managed jobs, explicit run history, and manual triggering.

## Schedule from a conversation

Ask your agent to create or update a schedule, or use `/cron`. In orchestration mode, the agent delegates to a worker which discovers the cron tools on demand. The worker can access only schedules owned by its agent; API credentials remain in the gateway. Existing jobs are updated in place.

App-agent workers may create and manage schedules that run agent prompts inside their container. They cannot schedule host shell commands or trigger jobs with `cron_run`; use the authorized operator API for immediate runs. Revoked or completed worker attempts cannot continue changing schedules.

## Add a heartbeat

Put this YAML in the agent's `HEARTBEAT.md`:

```yaml
tasks:
  - name: morning-brief
    cron: "0 8 * * *"
    prompt: "Give a brief morning summary."
  - name: check-in
    interval: 6h
    prompt: "Check if there are any reminders to send."
```

Cron expressions use five fields: minute, hour, day, month, weekday. Supported interval examples include `30m`, `1h`, `6h`, `1d`, and `1w`. Heartbeats use the gateway process timezone; managed cron jobs have their own timezone and default to UTC. The default proactive rate limit is 30 minutes; a `HEARTBEAT_OK` reply suppresses the Telegram message.

## Inspect a managed job

```bash
claude-gateway crons list --agent assistant
claude-gateway crons get JOB_ID
claude-gateway crons runs JOB_ID
```

Replace `JOB_ID` with an ID from the list. Check the schedule, enabled state, delivery configuration, and latest run result. To intentionally execute it immediately:

```bash
claude-gateway crons run JOB_ID
```

This runs the job's real action. Confirm the completed run and its delivery; an accepted trigger alone does not establish success. Use `claude-gateway crons create --help` for the current creation flags and the [API reference](../reference/cli-api.md) for request bodies and delivery options.

Schedules trigger work; the [orchestration engine](./orchestration.md) manages delegated execution and task state.

## Choose the right scheduler

| Behavior | Workspace heartbeat | Managed cron job |
| --- | --- | --- |
| Definition | `HEARTBEAT.md` YAML | Persisted job created through CLI/API/tools |
| Action | Agent prompt | Shell command or agent prompt |
| Schedule | Five-field cron or supported interval shorthand | Recurring cron or one-shot `at` |
| Timezone | Gateway process timezone | Explicit job timezone, otherwise UTC |
| Quiet outcome | `HEARTBEAT_OK` suppresses a proactive message | Inspect execution and configured delivery |
| State | Heartbeat run history | Enabled state, counters, last status/error, run logs |

The heartbeat parser requires a nonempty `name` and `prompt` and exactly one of `cron` or `interval`. Place `tasks:` at the root of the YAML; the parser stops collecting at an unindented Markdown heading. Invalid YAML can yield no tasks, while invalid task fields produce a parse error in the scheduler log. Always verify the reported loaded-task count after editing.

## Intervals are wall-clock schedules

Heartbeat shorthand converts to cron; it is not elapsed time since the previous completion:

| Shorthand | Cron equivalent | Meaning |
| --- | --- | --- |
| `30m` | `*/30 * * * *` | At minutes 0 and 30 |
| `6h` | `0 */6 * * *` | At 00:00, 06:00, 12:00, 18:00 |
| `1d` | `0 0 * * *` | At midnight |
| `1w` | `0 0 * * 0` | At midnight on Sunday |

Minute values are 1–59, hour values 1–23, and day/week support only `1d`/`1w`. For example, `2d` and `24h` are not supported shorthand. The 30-minute proactive rate limit is shared across the agent's heartbeat tasks, so a recently sent proactive message can suppress another task. Inspect the `suppressed` and `rateLimited` result fields when delivery is absent. Heartbeat response collection defaults to a 60-second timeout.

Source: [heartbeat parser](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/heartbeat/parser.ts) and [heartbeat scheduler](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/cron/scheduler.ts).

## Managed execution, persistence, and restart behavior

A managed job defaults to `scheduleKind: "cron"`, `type: "command"`, and enabled. An agent task instead needs `type: "agent"`, an agent ID, and a prompt. One-shot jobs use `scheduleKind: "at"` with `scheduleAt`. Prefer an explicit timezone for recurring jobs and an explicit offset in a one-shot timestamp.

By default jobs persist in `~/.claude-gateway/crons.json`, with run logs in `~/.claude-gateway/cron-runs/`; the manager retains the latest 100 log entries per job. Agent tasks use a job-specific `cron-<jobId>` session. Without orchestration their default timeout is 120 seconds. Shell execution has a fixed 120-second timeout in the current implementation.

On startup, enabled recurring jobs that previously ran can receive one catch-up execution when a scheduled tick was missed. Catch-up considers the job's timezone, is capped at five jobs per startup, and staggers them five seconds apart. It does not replay every missed tick. Never-run recurring jobs wait for their normal schedule; past one-shot jobs are handled by their own scheduling path.

For diagnosis, compare `lastRunAt`, `lastStatus`, `lastError`, `consecutiveErrors`, and the run log with the intended action. Then verify Telegram or Discord delivery separately. Restarting the gateway can trigger catch-up, so account for that before restarting a scheduler that performs external actions.

Source: [managed cron implementation](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/cron/manager.ts).

## Scheduled agent work with orchestration

With orchestration enabled, a scheduled agent prompt can create managed execution tasks. The cron path waits for those tasks before producing its result and uses stable job-scoped ownership across restarts. It adds a fresh-run instruction so previous scheduled results are treated as history rather than current observations.

An explicit job `timeoutMs` takes precedence. Otherwise the orchestration cron wait uses the worker total deadline plus the conversation decision ceiling when a worker total deadline is configured. With the default `tasks.maxDurationMs: 0`, that outer wait has no total deadline; worker startup, response, and inactivity controls still apply. A timeout log can include `phase`, elapsed time, and idle time, which helps distinguish slow startup from a task that stopped making progress.

Source: [cron orchestration integration](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/cron/manager.ts).

## Worker capability limits

The skill catalog describes installed instructions, not an authorization grant.
`capabilities_list` marks skills with known unavailable declared gateway tools as
`tool_access_limited`. For example, app installation/management and agent creation
are administrative capabilities, not automatically granted to orchestration workers.
Retrying such a skill or entering its slash command does not bypass that boundary.

Host workers can discover configured browser, image, video, file sharing and scoped
memory capabilities through the gateway catalog. Channel delivery is performed by
the orchestrator, not by worker bot credentials. Container workers have a separate
restricted inventory; host media, browser and shared-memory access is not implied.
External MCP servers depend on the selected worker harness and its configuration.

## Manual runs from workers

For a host worker, `cron_run` waits for the real job result, including delegated
work and the final agent report. It does not use the short 15-second CRUD deadline.
Worker cancellation, ticket revocation, gateway shutdown or a disconnected MCP
caller interrupts the wait; **it does not cancel an already dispatched cron job**.
If the response is lost, `CRON_OUTCOME_UNKNOWN` means the execution or mutation
may still complete. Inspect `cron_get_runs` and `cron_list` before retrying; never
interpret this as proof that nothing happened. Lookup and HTTP API errors remain
explicit `CRON_API_ERROR` results. MCP clients may impose their own wait limits.
