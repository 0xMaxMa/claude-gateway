# Operations and upgrades

## Run as a service

Review the generated service definition, then install it:

```bash
claude-gateway service install --print
claude-gateway service install
claude-gateway service status
claude-gateway gateway status
```

The default is a systemd user service. Install prompts for confirmation and starts the service. If it must survive logout, enable lingering for its operating-system user with `loginctl enable-linger USERNAME`. PM2 and system-scope systemd are also supported.

`gateway restart` drives the currently active owner. `service start` and `service restart` can find an installed but stopped service. Start/restart exit code `2` means the action succeeded but health could not be confirmed; inspect logs before treating it as healthy.

## Observe the running system

```bash
claude-gateway gateway status
claude-gateway gateway logs --lines 100
claude-gateway gateway logs --follow --agent assistant
claude-gateway doctor
```

Use `/dashboard` for sessions and knowledge views. Log in with an admin key. Keep `/health` checks alongside a real agent round trip: a responsive HTTP listener does not prove a channel or model works.

## Upgrade deliberately

```bash
claude-gateway version
claude-gateway update check
```

Review release changes and back up configuration, agent workspaces/session data, and relevant app data before upgrading. Store backups securely because configuration contains credentials. Stop or coordinate active work before restarting.

```bash
claude-gateway update
claude-gateway gateway restart
claude-gateway gateway status
claude-gateway doctor
```

The update command confirms before replacing the installed package. The running process continues using its previous build until restarted. Afterward, check the version and send a test message over each important channel.

For Claude Code itself, use `claude-gateway claude update check` and `claude-gateway claude update`; it uses Claude Code's native updater. Older service units that invoke the binary without a command should be updated to explicit `gateway start`.

## Preserve a recovery path

Keep the previous package version and a matching backup recorded. A rollback must consider configuration migration and runtime data as well as package files. Avoid changing branches or rebuilding a source deployment while it is serving traffic. Work in an independent checkout, then deploy a consistent revision.

See [troubleshooting](./troubleshooting.md) for targeted failure diagnosis.

## Choose a process owner

| Mode | Suitable use | Operational detail |
| --- | --- | --- |
| Foreground `gateway start` | Development or supervision by another process manager | Terminal/process owner controls lifetime |
| systemd user service | One user's normal deployment | Default service install; lingering may be needed after logout |
| systemd system service | Machine-managed deployment under a dedicated user | Requires explicit `--scope system --run-as USERNAME` |
| PM2 | Existing PM2-managed environments | Select with `--manager pm2`; system scope is not supported |

Preview an alternative service definition before installing:

```bash
claude-gateway service install --scope system --run-as gateway --print
claude-gateway service install --manager pm2 --print
```

Replace `gateway` with an existing operating-system account. For a system service, ensure that account can read the intended configuration and workspace and run the provider executable. A root shell's home and credentials are not the service account's home and credentials.

The installer checks for an enabled or active unit at the opposite systemd scope and refuses to create a competing owner. If it reports a conflict, inspect both scopes and decide which should own the gateway before installing. Two independent processes can compete for the HTTP port or channel polling even if their service names look similar.

Source: [service command and unit rendering](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/cli/commands/service.ts).

## Separate process health from end-to-end health

Use service status to determine whether the supervisor believes the process is running. Use gateway status and `/health` to determine whether the intended gateway responds. Use one real agent message to check authentication, executable discovery, workspace loading, and model response. Finally, test the channel or app path used by people.

When a start/restart returns exit code `2`, the owner action completed but health verification did not establish readiness. Inspect startup logs and the configured address before retrying: immediately starting another process can turn a slow startup into a duplicate-owner problem.

An interactive shell may have a different `PATH` and environment from a service. If `claude` or Bun works in a terminal but fails under supervision, inspect the service definition and run-as account. The gateway includes native Claude binary discovery, but a missing installation or authentication under the service account still needs to be fixed.

Source: [gateway lifecycle command](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/cli/commands/gateway.ts), [health checks](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/cli/health.ts), and [Claude executable discovery](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/session/claude-bin.ts).

## Back up by data responsibility

Preserve the effective config file and referenced credentials, agent workspace source files, session persistence, history databases, personal/shared knowledge sources, and managed cron storage. For container apps, use the app backup flow to capture data that lives in Docker volumes; copying only the gateway directory is not sufficient for those volumes.

Record the gateway package version and provider version alongside the backup. After recovery or upgrade, check selected agent/session, personal and shared retrieval, enabled schedules, restored apps, and each important channel. A successful package install does not verify these persisted-data paths.
