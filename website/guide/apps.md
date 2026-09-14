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

See the [App Store reference](https://github.com/0xMaxMa/claude-gateway/blob/main/README.md#app-store) and [CLI install semantics](https://github.com/0xMaxMa/claude-gateway/blob/main/CLI.md#app-store-docker-compose-apps) for manifests, sources, and backup operations. Container admission and migration behavior specific to orchestration belongs to the [unreleased preview](../preview/orchestration.md).
