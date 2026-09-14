# Operations and upgrades

## Run as a service

Review the generated service definition, then install it:

```bash
claude-gateway service install --print
claude-gateway service install
claude-gateway service status
claude-gateway gateway status
```

The default is a systemd user service. Install prompts for confirmation and starts the service. If it must survive logout, enable lingering for its operating-system user as described in the [service reference](https://github.com/0xMaxMa/claude-gateway/blob/main/CLI.md#running-as-a-service). PM2 and system-scope systemd are also supported.

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
