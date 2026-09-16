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

## Gateway will not start: doctor and repair

Run these commands as the same OS user that runs the gateway. They do not need a
running gateway API to inspect or repair local files and dependencies.

```bash
claude-gateway doctor
claude-gateway doctor fix
# Non-interactive provisioning (explicitly accepts the repair):
claude-gateway doctor fix --yes
```

| Finding | What `doctor fix` does | What still needs your decision |
| --- | --- | --- |
| ffmpeg or ffprobe missing/unusable | Installs the ffmpeg package through apt-get (Linux) or Homebrew (macOS), then checks both executables | Package-manager/network/PATH failures or unsupported OS; use the printed manual command |
| Config owner permissions wrong | Saves a private backup and sets a regular file owned by the current user to 0600 | Foreign ownership, symlinks, inaccessible parent directories |
| Config begins with a UTF-8 BOM | Backs up and removes the BOM only if the remaining JSON parses | Other invalid JSON or invalid agent settings must be corrected manually |
| Log directory missing | Creates the configured directory with private permissions | Existing directories with wrong ownership/access |
| Linux user service is failed | Resets the service failure latch without starting it | Correct the original failure, then start; outdated service paths need `service install` |
| Port already in use | Reports a known startup-log signature | Identify the process; doctor will not kill it or select a different port |
| Orchestration instance already running | Reports a known startup-log signature | Inspect the running instance; do not delete SQLite lock files |
| Missing API credentials or agents | Reports configuration/connectivity gaps | Restore valid settings; doctor will not generate replacement identities |

Runtime and log checks do not perform full config validation. Recent-log hints
are historical matches from the bounded end of `gateway.log`, not proof that a
previous failure is still present; raw log lines and credentials are not printed.

After fixing the reported problems, start using your existing launch method:

```bash
claude-gateway gateway start
# Or, for an installed service:
claude-gateway service start
```

In a second terminal, run `claude-gateway doctor` again and verify a real request.
A repair report with `health: no response` means the process still is not answering;
it does not mean all repairs failed. No repair automatically restarts active tasks.

### Voice works with one provider but fails with another

ElevenLabs streaming requests PCM directly. PaxaLabs and OpenRouter streaming
paths need local ffmpeg conversion. Gemini voice-file creation also uses ffmpeg;
LINE delivery uses ffmpeg and ffprobe to create and validate AAC/M4A. Preview is
therefore not the only affected feature. Tools installed in an upstream provider
container do not provide these binaries inside a separate gateway host/container.

Missing executables produce a local-dependency message with `doctor fix` guidance,
not a claim that the provider sent corrupt audio. Install on the gateway host:

```bash
# Debian/Ubuntu, if explicit doctor repair cannot install:
sudo apt-get update
sudo apt-get install -y ffmpeg
# macOS, with Homebrew already installed:
brew install ffmpeg

ffmpeg -version
ffprobe -version
```

Use the command appropriate for your OS. Installation requires root or working
non-interactive sudo on apt-based systems; repair never waits for a sudo password.
If a service still cannot find the binaries, check its PATH and installation
namespace rather than repeatedly calling the provider. Repeat Preview after fixing
the dependency; it makes a real provider request and may incur normal usage.

For a config owned by the current user without read permission, repair restores access
before it can copy the contents into a private backup. It does not change file
contents during this step. Linux supports mode `000` through a pinned file
descriptor and `/proc`; other systems can recover write-only files. If neither
method is available, restore owner read access manually and rerun doctor.
