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

For preview-only failures such as `ORCHESTRATION_DISABLED` or `PROFILE_INVENTORY_MISMATCH`, use the [PR #465 task guide](../preview/orchestration.md). Those diagnostics are not part of main's legacy task model.
