# Troubleshooting

Start with the smallest failing boundary: process, API, agent, provider, then channel delivery.

```bash
claude-gateway gateway status
claude-gateway doctor
claude-gateway gateway logs --lines 100 --agent assistant
```

| Symptom | Check | Verification after the fix |
| --- | --- | --- |
| Nothing listens | Owning service, bind address, port, startup log | `/health` answers on the intended address |
| Health works, agent fails | Workspace exists, `AGENTS.md`, Claude authentication and executable | Agent answers a short direct request |
| Telegram bot stays silent | Pairing, allowed user, duplicate poller | Paired private chat receives a reply |
| Telegram group stays silent | Privacy Mode/admin status, group allowlist, mention gate | Mention produces a reply in the approved group |
| Discord receives empty messages | Message Content Intent and channel permissions | Bot receives text and answers |
| LINE webhook rejected | Signature and unchanged raw request body | A new signed webhook is accepted |
| MCP tools unavailable | Bun, MCP dependencies, generated session MCP config | A read-only tool returns a real result |
| API rejects a key | Key value, agent scope, write/admin requirement | The same request succeeds with appropriate scope |
| Personality unchanged | Source workspace files, generated `CLAUDE.md` | New turn reflects the edited instructions |
| Heartbeat did not send | YAML, five-field cron, timezone, rate limit, `HEARTBEAT_OK` | Run evidence and intended channel delivery |

## Local commands work, public URL fails

A proxy may enforce separate authentication. Compare the address reported by `doctor` with the intended destination. Local CLI commands normally prefer the running gateway's local address; setting `--url` deliberately tests another address. `gateway.publicUrl` must point to this gateway's externally reachable origin for features that generate public links.

## Context looks missing

Check that you selected the intended agent, chat, and session. Session persistence and permanent chat history are distinct stores. A missing session file starts a fresh context; do not delete history or configuration as a diagnostic shortcut. See [agents and sessions](./agents.md) and [memory](./memory.md).

## Collect a useful report

`claude-gateway debug-bundle` writes a small redacted diagnostics bundle. Review it before sharing, and include the installed version, failing command or action, expected behavior, actual result, and relevant timestamps. Remove credentials, private messages, and identifying data from manually copied logs.

For `ORCHESTRATION_DISABLED` or `PROFILE_INVENTORY_MISMATCH`, inspect the gateway mode and runtime profile using the [orchestration guide](./orchestration.md).

## Memory search returns nothing or an old fact

Confirm the search corpus and shared project first. Personal archive sources are `MEMORY.md`, `USER.md`, and Markdown under `memory/`; another workspace document is not automatically indexed. Read the source file to distinguish a missing fact from a stale index. A generated core index is a context optimization and does not mean the full source was erased.

If a note used to be searchable, inspect dreaming and staleness records and whether the source moved or disappeared. For durable archival notes that must survive aging, use the documented `memory/pinned/` location. Verify the result by retrieving an exact source excerpt in a new session.

## A learned skill is missing or unexpectedly unchanged

Inspect `skills/.pending/` when learning runs in propose mode. In auto mode, inspect `SKILLS_LEARNED.md` and the live `SKILL.md`. Reaching the tool-call threshold only qualifies a session for review; the daily budget, reviewer outcome, duplicate checks, and provenance guard still apply. A human-authored same-name skill is deliberately protected from automatic overwrite.

For shared skills, edit `~/.claude-gateway/shared-skills/`, then verify the managed personal copy and generated menu. Editing only a `.shared`-marked copy in `~/.claude/skills/` can be undone on the next synchronization.

## An app is installed but its URL fails

Read the installation job's terminal state and logs, then inspect the app's declared port name. The proxy path uses the manifest's name, not an arbitrary container port number. Check whether the app is still `restoring` or reports a boot `restoreError`. Rebuilds on a fresh Docker host may need longer than a simple restart.

If the app has an agent, check its workspace link, generated agent container, mounted binary paths, and staged Claude configuration. A host login change can refresh the seed without refreshing an already running container's copied configuration. Follow the [app lifecycle and backup guide](./apps.md) before reinstalling or restoring data.

## A schedule fires at the wrong time or after restart

Heartbeats use the process timezone and convert interval shorthand into wall-clock cron. Managed cron jobs default to UTC unless their own timezone is set. Compare the actual schedule type and timezone rather than applying one scheduler's rules to the other.

Managed recurring jobs can catch up missed work after startup; this is capped and does not replay every missed tick. Inspect the prior run timestamp and current run log before manually triggering the job. A missing heartbeat message may instead be a normal rate-limited or `HEARTBEAT_OK` result.

Source modules for these checks: [knowledge indexing](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/agent/knowledge/indexer.ts), [skill writer](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/agent/skill-learning/writer.ts), [app installer](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/apps/installer.ts), and [cron manager](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/cron/manager.ts).

## A task is queued, blocked, or failed

Read the persisted task state before retrying. `queued` means execution has not started; a progress acknowledgement does not change that. Check per-conversation/per-agent task limits, gateway process capacity, predecessor state, and workspace availability. An `after_success` continuation whose predecessor failed reports `TASK_DEPENDENCY_FAILED`; authorized recovery can use an `after_terminal` continuation with instructions to inspect the existing state first.

| Error | Meaning | Targeted check |
| --- | --- | --- |
| `ORCHESTRATION_DISABLED` | The task path is not enabled | Gateway-wide orchestration switch |
| `PROFILE_FLAGS_CONFLICT` | Custom Claude flags conflict with a managed profile | Remove conflicting `claude.extraFlags`; use supported settings |
| `CLI_SKILL_UNAVAILABLE` | Native skill absent from this worker runtime | Actual host/container skill inventory |
| `WORKER_GIT_PROJECT_REQUIRED` | Explicit worktree policy requires a Git project | Selected workspace mode and project root |
| `SHARED_PROJECT_MUST_DIFFER_FROM_IDENTITY_WORKSPACE` | Shared-lock project overlaps identity workspace | Use a separate project directory |
| `CONTAINER_ISOLATION_REQUIRED` | App container fails admission | Runtime privileges, namespaces, capabilities, and mounts |
| `ARTIFACT_PATH_DENIED` | Requested file is outside the permitted artifact scope | Original file location and active task/session ownership |

After interruption, inspect current files, remote side effects, and recorded test evidence before retrying the action. A timeout does not establish that edits disappeared or that a deploy failed. Likewise `cancel_requested` means stopping has been requested; report cancellation only after the terminal cancelled state is confirmed. Stopping a spoken response or chat decision does not cancel ongoing execution tasks.

Source: [runtime profile rules](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/session/runtime-profile.ts), [worker driver](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/orchestration/tasks/driver.ts), and [task controls](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/orchestration/task-controls.ts).
