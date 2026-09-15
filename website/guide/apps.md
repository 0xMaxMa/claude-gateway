# Apps

The App Store installs Docker Compose applications and exposes their declared ports through the gateway proxy. Some apps also include an agent or host-script bridge.

## Inspect and install

You need a working Docker/Compose environment and an admin API key. Start by listing installed apps:

```bash
claude-gateway app list
```

Install from a registry name, a GitHub URL, or an existing local app directory. For example, for a local app you have reviewed:

```bash
claude-gateway app install ./my-app --wait
```

The source directory must contain the gateway app manifest and its required files. `--wait` polls the installation job and streams logs. Without it, the command returns an accepted `jobId`; inspect completion with `claude-gateway api GET /v1/apps/jobs/JOB_ID`.

App URLs follow `/app/:name/:portName/*`. Verify the job's final result, then load the app and exercise a small action before calling the installation successful.

## Operate an app

```bash
claude-gateway app restart APP_NAME
claude-gateway app list
```

Use `--env-file` when an install needs secrets. An uninstall removes containers and installed files while retaining backups; it asks for confirmation. Review `gateway.appBackup`, `gateway.appRestore`, and `gateway.appHousekeeping` when planning storage and recovery.

See the [manifest generator](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/apps/compose-generator.ts) and [installation implementation](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/apps/installer.ts) for validation and lifecycle details. See [orchestration](./orchestration.md) for container admission and delegated task lifecycle.

## Manifest and installation lifecycle

An app source contains `app.yaml`. The gateway validates the manifest, derives its canonical name, generates `docker-compose.yml` and `.env`, then builds/starts the declared services and records the installed app. Declared port names identify proxy destinations, while host-port overrides resolve local conflicts. Duplicate or disallowed host ports are rejected during generation.

A returned installation `jobId` means the operation was accepted. Follow its logs until the job reaches a terminal result. A container can start while the application behind its port still has configuration or database errors, so test a real page or API call after the job completes. When installing from a local directory, provide a path visible to the gateway host.

During gateway startup, apps previously marked running may be restored asynchronously. App responses expose `restoring` during recovery and `restoreError`/`restoreFailedAt` when that boot attempt failed. This is especially relevant after moving app data to a host without cached images: rebuilding may be needed before the app becomes reachable. `gateway.appRestore` sets the build/start budgets.

Source: [installer](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/apps/installer.ts) and [app API restore status](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/api/apps-router.ts).

## App agents and runtime boundaries

An app can declare an agent workspace. The gateway registers it as an agent and links its workspace to the app's installed directory. Its generated agent container mounts that workspace at `/workspace`, uses the host user's numeric identity, drops all Linux capabilities, and enables `no-new-privileges`. Agent media is mounted at its host-identical absolute path so uploaded images and screenshots resolve correctly.

The container receives read-only host binary mounts and a read-only staged Claude configuration seed. The seed is copied into a writable container configuration file at container start, allowing Claude to perform atomic rewrites. Refreshing the staged seed on gateway reconciliation does not itself restart an already running container; check the container lifecycle when an account change is not reflected.

These are explicit mounts and execution boundaries, not a guarantee that arbitrary app code is harmless. Review the generated Compose file, app services, port exposure, and any declared host-script bridge. The bridge exists to run approved app scripts through the host socket, so its declared capabilities matter when assessing what the app can access.

Source: [app agent manager](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/apps/agent-manager.ts), [Compose generation](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/apps/compose-generator.ts), and [host socket server](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/apps/socket-server.ts).

## Back up and restore application data

The app API provides asynchronous backup and restore operations:

| Request | Result |
| --- | --- |
| `POST /v1/apps/APP_NAME/backup` | Starts a backup job |
| `GET /v1/apps/APP_NAME/backups` | Lists available backups, newest first |
| `POST /v1/apps/APP_NAME/restore` with `{"backupId":"BACKUP_ID"}` | Starts a restore job |
| `DELETE /v1/apps/APP_NAME/backups/BACKUP_ID` | Deletes one backup |
| `GET /v1/apps/jobs/JOB_ID` | Shows operation progress and result |

For example, inspect existing backups with:

```bash
claude-gateway api GET /v1/apps/APP_NAME/backups
```

A backup stops the app for a snapshot, archives named volumes and eligible app-local bind-mount directories, and captures `.env`, `app.yaml`, and Compose configuration. It attempts to restart the app in a `finally` path even if archiving fails. Check both the job and the app state afterward. Volume archives are created with helper containers to preserve file ownership without changing ownership of host data.

Backups normally live in `<appsDir>/.backups/<app>/`. The default policy keeps the latest three backups and prunes archives older than 30 days. `gateway.appBackup` controls retention and daily cleanup. Treat backup archives as sensitive because they include `.env` and application data, and copy required recovery points outside the deployment host.

Restoring replaces the relevant volume content and configuration before starting the app. Plan for downtime and verify a known record after restore. Uninstall attempts a best-effort backup, but a failed backup does not block the requested uninstall; create and verify an explicit backup first when recovery is required. Backups are retained after uninstall.

App housekeeping reports orphaned Docker volumes instead of automatically deleting them. Check ownership and recovery needs before removing such volumes yourself.

Source: [backup, restore, and housekeeping implementation](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/apps/installer.ts).

## Orchestration container admission

Before task execution, the gateway inspects the app-agent container. It must be running, unprivileged, drop all capabilities, and enable `no-new-privileges`. Host/container-shared networking, PID namespace overrides, extra capabilities, and device mounts are rejected. Mounts are checked against the agent workspace, media, and recognized read-only runtime/seed mounts; Docker/containerd sockets and unrelated host mounts are denied.

Execution and skill discovery happen through `docker exec`. If validation fails, fix the app's declared runtime and container state; a host retry is forbidden. A missing `/workspace` binding produces `CONTAINER_WORKSPACE_REQUIRED`; an unsafe runtime produces `CONTAINER_ISOLATION_REQUIRED` or `CONTAINER_HOST_MOUNT_DENIED`.

The container receives a small task-scoped MCP bridge rather than the host module loader. Artifacts are read inside the container and imported into a gateway-owned spool, with allowed paths under `/workspace/` or `/tmp/`, regular-file checks, and a 50 MiB size limit. This avoids resolving an app-controlled path in the host filesystem. Creating a file alone does not deliver it: the task must stage it and complete successfully.

Source: [container validation, bridge, and artifact import](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/orchestration/container.ts).
