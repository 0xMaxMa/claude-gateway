---
name: cron
description: Manage scheduled cron jobs for this agent — list, create, delete, run, and view run history. Use when the user asks to schedule tasks, set up recurring jobs, or check cron status.
user-invocable: true
allowed-tools:
  - cron_list
  - cron_create
  - cron_delete
  - cron_run
  - cron_get_runs
---

# /cron — Cron Job Management

Manage scheduled jobs for this agent via the gateway cron API.

Arguments passed: `$ARGUMENTS`

---

## Available commands

### No args or "list" — List all cron jobs

Use `cron_list` to show all scheduled jobs. Format the output as a table.

### "create" — Create a new cron job

Use `cron_create` with the required parameters:
- `name`: descriptive job name
- `schedule`: 5-field cron expression (e.g. `0 9 * * *` for daily at 9am)
- `type`: `command` (shell) or `agent` (Claude prompt)
- For `command` type: provide `command` parameter
- For `agent` type: provide `prompt` parameter, optionally `telegram` (chat_id for response)

### "delete <job_id>" — Delete a cron job

Use `cron_delete` with `job_id`.

### "run <job_id>" — Run a job immediately

Use `cron_run` with `job_id`.

### "runs <job_id>" — View run history

Use `cron_get_runs` with `job_id`. Format as a table showing status, duration, and timestamps.
