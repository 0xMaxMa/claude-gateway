# Schedules and heartbeats

Use `HEARTBEAT.md` for workspace-defined proactive behavior. Use the cron API or CLI when you need managed jobs, explicit run history, and manual triggering.

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

Cron expressions use five fields: minute, hour, day, month, weekday. Supported interval examples include `30m`, `1h`, `6h`, `1d`, and `1w`. Check the gateway timezone before interpreting “8 AM.” The default proactive rate limit is 30 minutes; a `HEARTBEAT_OK` reply suppresses the Telegram message.

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

This runs the job's real action. Confirm the completed run and its delivery; an accepted trigger alone does not establish success. Use `claude-gateway crons create --help` for the current creation flags and the [cron API reference](https://github.com/0xMaxMa/claude-gateway/blob/main/API.md) for request bodies and delivery options.

Scheduled jobs on main are separate from [PR #465's delegated tasks](../preview/orchestration.md).
