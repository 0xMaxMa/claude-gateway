# App Store API {#app-store-api}

Manage Docker-compose apps installed on the gateway. Apps can be sourced from the community registry or a custom GitHub repository.

**Auth levels:** All App Store endpoints require API key auth. Write operations (install, update, uninstall, start/stop/restart) require an **admin** key.

**Proxy routes:** Installed apps are exposed at `/app/:name/:portName/*` (no auth required at proxy layer — authentication is handled by each app).

---

## Endpoints Overview {#endpoints-overview}

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/apps/registry` | Key | Fetch community registry (5-min cached) |
| `GET` | `/api/v1/apps/registry/:name` | Key | Get versions of a specific registry app |
| `GET` | `/api/v1/apps` | Key | List all installed apps |
| `POST` | `/api/v1/apps/install` | Admin | Start async install → returns `jobId` |
| `POST` | `/api/v1/apps/inspect` | Admin | Read-only preview of a source → required/generated secrets (no install) |
| `GET` | `/api/v1/apps/jobs/:jobId` | Key | Poll install/update job status + logs |
| `GET` | `/api/v1/apps/:name` | Key | Get installed app info |
| `DELETE` | `/api/v1/apps/:name` | Admin | Uninstall app (docker down + cleanup) |
| `POST` | `/api/v1/apps/:name/start` | Admin | Start stopped app |
| `POST` | `/api/v1/apps/:name/stop` | Admin | Stop running app |
| `POST` | `/api/v1/apps/:name/restart` | Admin | Restart app |
| `GET` | `/api/v1/apps/:name/version` | Key | Check current + latest version |
| `POST` | `/api/v1/apps/:name/update` | Admin | Start async update with rollback → returns `jobId` |
| `POST` | `/api/v1/apps/:name/reconfigure` | Admin | Start async env/host-port reconfigure (keeps volumes) → returns `jobId` |

---

## GET /api/v1/apps/registry {#get-apiv1appsregistry}

Fetch the community registry (cached 5 minutes, falls back to stale on network failure).

```bash
curl -H "X-Api-Key: my-key" http://localhost:10850/api/v1/apps/registry | jq
```

```json
{
  "updated_at": "2026-05-19T00:00:00.000Z",
  "apps": [
    {
      "name": "agent-note",
      "description": "Note-taking app with AI agent",
      "repo": "https://github.com/0xMaxMa/app-agent-note",
      "author": "0xMaxMa",
      "versions": [
        { "version": "1.0.0", "commit": "abc123def456abc123def456abc123def456abc1", "approved_at": "2026-05-01T00:00:00.000Z" }
      ]
    }
  ]
}
```

---

## GET /api/v1/apps/registry/:name {#get-apiv1appsregistryname}

Get all versions of a specific app from the community registry.

```bash
curl -H "X-Api-Key: my-key" http://localhost:10850/api/v1/apps/registry/agent-note | jq
```

**Error responses:**

| Status | When |
|--------|------|
| 404 | App not found in registry |
| 502 | Registry fetch failed |

---

## GET /api/v1/apps {#get-apiv1apps}

List all installed apps and their status.

```bash
curl -H "X-Api-Key: my-key" http://localhost:10850/api/v1/apps | jq
```

```json
{
  "apps": [
    {
      "name": "agent-note",
      "version": "1.0.0",
      "commit": "abc123def456abc123def456abc123def456abc1",
      "githubUrl": "https://github.com/0xMaxMa/app-agent-note",
      "installPath": "/home/user/.claude-gateway/apps/agent-note",
      "ports": [{ "name": "web", "service": "app", "containerPort": 4000, "type": "web", "rateLimit": 200 }],
      "sockets": {},
      "installedAt": "2026-05-19T10:00:00.000Z",
      "updatedAt": "2026-05-19T10:00:00.000Z",
      "status": "running",
      "source": "registry"
    }
  ]
}
```

**`status` values:** `running` | `stopped` | `error` | `building`

> **Live status:** `GET /api/v1/apps` and `GET /api/v1/apps/:name` reconcile the stored status against the live Docker runtime (`docker compose ps`) on read, so a container that crashed, was OOM-killed, was stopped from outside the gateway, or is stuck in a crash-restart loop reports `stopped`/`error` rather than a stale `running`. A `running` container (or one doing a clean/transient restart) → `running`; a container stuck `restarting` after a non-zero exit (crash-loop), an exit with a non-signal non-zero code, or a `dead` container → `error`; no containers, a clean exit, or a container force-killed by an explicit stop (exit 137/SIGKILL or 143/SIGTERM) → `stopped`. If Docker cannot be queried (daemon down, compose file missing) the last stored status is returned unchanged, and an app mid-install (`building`) is not reconciled.

> **Boot restore:** an app whose containers the boot-time restore is still bringing up is **not** reconciled either — its stored status is returned as-is, so a read landing mid-restore cannot see the not-yet-created containers and write `stopped` underneath it. Because the apps restored are exactly those stored as `running`, that status alone cannot tell a rebuild in progress from an app that is actually serving, so the entry carries `restoring` while the restore is in flight. If that restore **failed**, the app reports `error` together with two further fields, and the stored `running` intent is deliberately left alone so the next boot retries it:
>
> | Field | Description |
> |-------|-------------|
> | `restoring` | `true` while this process's boot restore is still bringing the app up — its containers may not exist yet, so the reported `status` is the stored intent, not observed state |
> | `restoreError` | Why this process's boot restore of the app failed (compose error or timeout) |
> | `restoreFailedAt` | ISO timestamp of that failure |
>
> All three are absent unless they apply (never `false`), and are in-memory only — they describe the current gateway process. The batch to restore is marked before the gateway accepts its first request, so there is no startup window in which an app awaiting restore reports a bare `running`. `restoring` clears the moment that app's own restore ends, so a boot's restore surfaces as either in-flight or failed rather than both at once. The failure fields clear as soon as the app is observed `running`, or on an explicit start/stop.

**`source` values:** `registry` | `custom` | `local`

---

## POST /api/v1/apps/install {#post-apiv1appsinstall}

Start an asynchronous install job. Returns immediately with a `jobId` to poll.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `registry_app` | One of | App name from community registry |
| `version` | No | Specific version from registry (default: latest) |
| `github_url` | One of | GitHub repo URL — must be `https://github.com/<owner>/<repo>` (no other hosts accepted) |
| `commit` | If `github_url` | 40-char hex commit SHA (branch names not accepted). Omit to auto-resolve HEAD. |
| `local_path` | One of | Absolute path to local project dir (dev mode — symlinked, source never deleted) |
| `env_vars` | No | Pre-supplied env vars as a JSON **object** (not array). Keys must match vars declared in `app.yaml`. |
| `ports` | No | Host-port overrides as a JSON **object** mapping port name → host port (e.g. `{ "web": 4000 }`). Default host port comes from `app.yaml`. Overrides must be integers ≥ 1024 and not banned (`22`, `80`, `443`, `10850`). The integer/banned/`< 1024` checks are synchronous (`400`); a port **name** that the app does not declare is caught only once the source is fetched, so it surfaces as a **failed install job**, not a sync `400` (the app's `app.yaml` is not available until the job runs). Reconfigure, by contrast, validates names synchronously because the app is already installed. |

**Mode A — registry install:**
```bash
curl -X POST \
  -H "X-Api-Key: admin-key" \
  -H "Content-Type: application/json" \
  -d '{"registry_app": "agent-note"}' \
  http://localhost:10850/api/v1/apps/install | jq
```

**Mode A — registry install with specific version:**
```bash
curl -X POST \
  -H "X-Api-Key: admin-key" \
  -H "Content-Type: application/json" \
  -d '{"registry_app": "agent-note", "version": "1.0.0"}' \
  http://localhost:10850/api/v1/apps/install | jq
```

**Mode B — custom GitHub repo:**
```bash
curl -X POST \
  -H "X-Api-Key: admin-key" \
  -H "Content-Type: application/json" \
  -d '{
    "github_url": "https://github.com/myorg/my-app",
    "commit": "abc123def456abc123def456abc123def456abc1",
    "env_vars": { "DATABASE_URL": "postgres://..." }
  }' \
  http://localhost:10850/api/v1/apps/install | jq
```

**Mode C — local dev (symlink):**

Use when developing an app locally. Creates a symlink `~/.claude-gateway/apps/{name}` → your project directory instead of cloning. The full install pipeline (validate, compose, build, start) runs the same as other modes. Uninstalling removes only the symlink — your source directory is never touched.

```bash
curl -X POST \
  -H "X-Api-Key: admin-key" \
  -H "Content-Type: application/json" \
  -d '{"local_path": "/home/dev/projects/my-app"}' \
  http://localhost:10850/api/v1/apps/install | jq
```

After editing source, restart the app to pick up changes:
```bash
curl -X POST \
  -H "X-Api-Key: admin-key" \
  http://localhost:10850/api/v1/apps/my-app/restart | jq
```

```json
{ "jobId": "550e8400-e29b-41d4-a716-446655440000" }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | Missing required fields, invalid commit format, invalid `github_url` format, `env_vars` not an object, or path does not exist |
| 403 | Not an admin key |

> Poll `GET /api/v1/apps/jobs/:jobId` to track progress. Install pipeline: clone/symlink → validate `app.yaml` → generate compose → build images → start containers → register proxy routes. On failure, container logs are appended to `logs` before rollback.

---

## POST /api/v1/apps/inspect {#post-apiv1appsinspect}

Read-only preview of an install source. Fetches and parses the app's `app.yaml`
(shallow clone for registry/GitHub sources; direct read for a local path)
**without installing anything and leaving no files behind**, and returns the
metadata needed for an accurate pre-install summary — most importantly which
secrets the operator must supply versus which the gateway auto-generates.

This is essential for a **GitHub-URL** install: such apps have no registry entry,
so `GET /api/v1/apps/registry/:name` cannot reveal their required secrets — only
this endpoint can.

**Request body:** same source fields as install (`registry_app` [+ `version`],
`github_url` [+ `commit`], or `local_path`). `env_vars` is ignored — nothing is
injected. One of the three sources is required.

```bash
curl -X POST \
  -H "X-Api-Key: admin-key" \
  -H "Content-Type: application/json" \
  -d '{"github_url": "https://github.com/myorg/my-app"}' \
  http://localhost:10850/api/v1/apps/inspect | jq
```

**Response `200`:**
```json
{
  "name": "my-app",
  "version": "1.0.0",
  "source": "custom",
  "commit": "abc123def456abc123def456abc123def456abc1",
  "secretKeys": ["DB_PASSWORD"],
  "generatedKeys": [{ "key": "SESSION_SECRET", "encoding": "hex", "bytes": 32 }],
  "secretDefaults": { "NEXTAUTH_URL": "http://localhost:3737" },
  "ports": [{ "name": "web", "service": "app", "hostPort": 12000, "containerPort": 3000, "type": "web" }],
  "agentDeclaration": null,
  "warnings": []
}
```

- `secretKeys` — env vars the operator **must** supply (declared as bare keys in `app.yaml`).
- `generatedKeys` — secrets the gateway fills with a fresh random value at install (declared as `KEY=!generate:<encoding>:<bytes>`); never prompted for.
- `secretDefaults` — defaults for prompted secrets declared as `KEY=!default:<value>`. The key is still listed in `secretKeys` (prompted and editable), but the value here pre-fills the field; if the operator leaves it blank the default is written to `.env`. Only keys with a declared default appear. Precedence at install: operator-supplied value → default → empty.

**Error responses:**

| Status | When |
|--------|------|
| 400 | Missing source fields, invalid `github_url`/`commit` format, repo unreachable, or `app.yaml` missing/invalid |
| 403 | Not an admin key |

---

## GET /api/v1/apps/jobs/:jobId {#get-apiv1appsjobsjobid}

Poll the status of an async install or update job.

```bash
curl -H "X-Api-Key: my-key" \
  http://localhost:10850/api/v1/apps/jobs/550e8400-e29b-41d4-a716-446655440000 | jq
```

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "completed",
  "logs": [
    "[2026-05-19T10:00:01.000Z] Cloning https://github.com/0xMaxMa/app-agent-note",
    "[2026-05-19T10:00:05.000Z] Checked out commit abc123de",
    "[2026-05-19T10:00:06.000Z] Validating app.yaml",
    "[2026-05-19T10:00:07.000Z] Generating docker-compose.yml",
    "[2026-05-19T10:00:07.000Z] Building images",
    "[2026-05-19T10:00:45.000Z] Starting containers",
    "[2026-05-19T10:00:50.000Z] Containers healthy",
    "[2026-05-19T10:00:50.000Z] Install complete: {\"web\":\"/app/agent-note/web/\"}"
  ],
  "result": {
    "appName": "agent-note",
    "proxyUrls": { "web": "/app/agent-note/web/" },
    "secretKeys": ["DATABASE_URL"],
    "agentDeclaration": null
  },
  "startedAt": 1747648800000,
  "updatedAt": 1747648850000
}
```

**`status` values:** `pending` | `running` | `completed` | `failed`

When `status` is `failed`, `error` contains the failure message. If the containers started but failed the healthcheck, container logs are appended to `logs` before rollback. An update that fails before the new containers start says so (`Update failed during the directory swap`) rather than reporting a container failure. Rollback is normally invisible, with one deliberate exception: if live bind-mount data cannot be moved back into the restored app directory, the app is **not** restarted on a half-restored directory — the `-failed-` directory still holding that data is kept, `error` reports `Update failed and rollback also failed`, and the logs name the paths and the directory to recover them from:

```json
{
  "id": "...",
  "status": "failed",
  "logs": [
    "[2026-05-19T10:00:45.000Z] Starting containers",
    "[2026-05-19T10:00:47.000Z]   my-app  | 2026/05/19 10:00:46 API_KEY is required",
    "[2026-05-19T10:00:47.000Z]   my-app  | 2026/05/19 10:00:47 API_KEY is required",
    "[2026-05-19T10:00:47.000Z] Build/start failed — rolling back"
  ],
  "error": "Command failed: docker compose — container my-app is unhealthy",
  "startedAt": 1747648845000,
  "updatedAt": 1747648847000
}
```

**Error responses:**

| Status | When |
|--------|------|
| 404 | Job ID not found |

---

## GET /api/v1/apps/:name {#get-apiv1appsname}

Get info for an installed app.

```bash
curl -H "X-Api-Key: my-key" \
  http://localhost:10850/api/v1/apps/agent-note | jq
```

Returns the full `AppEntry` object (same shape as items in `GET /api/v1/apps`).

---

## DELETE /api/v1/apps/:name {#delete-apiv1appsname}

Uninstall an app: `docker compose down --rmi all`, remove proxy routes, sockets, agent entry, and app files.

```bash
curl -X DELETE \
  -H "X-Api-Key: admin-key" \
  http://localhost:10850/api/v1/apps/agent-note | jq
```

```json
{ "deleted": true, "name": "agent-note" }
```

**Error responses:**

| Status | When |
|--------|------|
| 403 | Not an admin key |
| 404 | App not installed |

---

## POST /api/v1/apps/:name/start|stop|restart {#post-apiv1appsnamestartstoprestart}

Start, stop, or restart an installed app's containers. Admin key required. Runs
synchronously and responds `200` once `docker compose` completes — there is no
`jobId` to poll. `stop`/`start` are idempotent (stopping an already-stopped app
or starting an already-running one is a clean no-op).

```bash
curl -X POST \
  -H "X-Api-Key: admin-key" \
  http://localhost:10850/api/v1/apps/agent-note/restart | jq
```

```json
{ "name": "agent-note", "action": "restart" }
```

**Errors:** `403` if the key is not an admin key · `404` if the app is not
installed (or `:action` is not one of `start`/`stop`/`restart`) · `409` if a
mutating job (install/update/reconfigure/backup/restore) is currently in
progress for the app · `500` on an underlying `docker compose` failure.

---

## GET /api/v1/apps/:name/version {#get-apiv1appsnameversion}

Check the currently installed version vs latest in the registry. Only meaningful for `source: "registry"` apps.

```bash
curl -H "X-Api-Key: my-key" \
  http://localhost:10850/api/v1/apps/agent-note/version | jq
```

```json
{
  "installed": "1.0.0",
  "installed_commit": "abc123def456abc123def456abc123def456abc1",
  "latest": "1.1.0",
  "latest_commit": "def456abc123def456abc123def456abc123def4",
  "behind": true,
  "updateable": true
}
```

For custom/local apps, `latest` and `latest_commit` are `null` and `updateable` is `false`.

---

## POST /api/v1/apps/:name/update {#post-apiv1appsnameupdate}

Start an async update. Uses blue/green swap: the new version is cloned and built in a hidden `.cg-update-*` staging directory **beside the app's install path** (same filesystem, so the swap is a rename), old containers are stopped, the staging directory is swapped into the permanent install path, and only then are the new containers started. Rollback is automatic if the new containers fail their health check. The `.env` from the previous install is copied forward, so volumes and secrets are preserved.

Starting *after* the swap is what keeps relative bind mounts (`./postgres/pgdata`) pointing at the app's permanent directory — a stack started from the staging path would bind newly created empty data and a stateful service would re-initialise (issue #396). App-owned bind directories are carried across the swap by rename, preserving inode and ownership.

If the updated release also ships content at a bind path (a tracked `.gitkeep`, seed files, an `init.sql`), the two are merged: **existing data always wins**, and release-provided files the previous version did not have are kept. A collision on a non-directory path — or a live directory the gateway user cannot even list, which no entry-by-entry merge can reach — preserves the existing data and logs a warning naming both the path and the release files being discarded, so a config file you bind-mount from the repo must be re-applied by hand after the update.

The `.cg-update-*` staging checkout left behind by a crash mid-update is swept on gateway boot. Release snapshots (`<appDir>-old-*`, `<appDir>-failed-*`) are **not**: either can hold the only copy of live bind-mount data, and the sweep deletes with `sudo rm -rf`. They are reported on the gateway console at boot and left for you to recover or remove.

A rollback restores the previous **image** as well as the previous source. A `build:` service's new image reuses the running one's tag (`<project>-<service>:latest`), so before building, the update tags each of the app's built images `<project>-<service>:cg-rollback-<id>` — that keeps the old image addressable and alive (under the containerd image store an untagged image is not retained as a `<none>` image). A rollback points the tag back at it, so the app returns on the exact release it was serving; the private tag is dropped once the update settles either way. If an image cannot be restored, the rollback rebuilds from the rolled-back source instead of starting the failed release's build, and logs which reference it could not restore.

The image tags are put back **before** the rollback decides whether to restart the app, so the deliberate no-restart case above still leaves `<project>-<service>:latest` naming the release the restored source actually is — finishing that recovery by hand cannot bring old source up on the failed release's build. In that case the private `cg-rollback-*` tags are also **kept** rather than dropped, since they are the last reference holding the pre-update image; the job log names them.

If the app declares an agent, its registration follows the new release: an agent whose name changed is deregistered under the old name before the new one is registered, and an agent the release no longer declares is deregistered entirely. Either way the agent's directory and session history are preserved (only the `workspace` symlink and the `config.json` entry are removed), and `MEMORY.md` is carried forward — written after the new registration exists, so it survives a rename.

The update target depends on the app's `source`:
- `registry` — the latest published registry version.
- `custom` (installed from a GitHub URL) — the current default-branch `HEAD` of the app's repo, resolved via `git ls-remote`. If the resolved commit already matches the installed one, the job completes as a no-op.
- `local` (symlinked directory) — not updatable; returns `400`.

```bash
curl -X POST \
  -H "X-Api-Key: admin-key" \
  http://localhost:10850/api/v1/apps/agent-note/update | jq
```

```json
{ "jobId": "661f9511-f30c-52e5-b827-557766551111" }
```

Poll the returned `jobId` with `GET /api/v1/apps/jobs/:jobId` to track progress.

**Error responses:**

| Status | When |
|--------|------|
| 400 | App source is `local` (symlinked apps cannot be updated) |
| 403 | Not an admin key |
| 404 | App not installed |

---

## POST /api/v1/apps/:name/reconfigure {#post-apiv1appsnamereconfigure}

Start an async reconfigure of an already-installed app — change its env vars and/or host ports, then force-recreate the container **in place**. Named volumes (and their data) are preserved: this is a `docker compose up --force-recreate`, never a `down -v`. The container always restarts so it picks up the new values.

**Request body** (at least one of `env_vars` / `ports` is required):

| Field | Required | Description |
|-------|----------|-------------|
| `env_vars` | One of | Env vars to **merge** into the app's existing `.env` as a JSON **object** (values must be strings). Keys not supplied are preserved; existing self-generated secrets are kept, not rotated. Passing an **empty string** (`""`) for a self-generating (`!generate`) key rotates it — the installer discards the old value and generates a fresh secret. |
| `ports` | One of | Host-port overrides as a JSON **object** mapping port name → host port (e.g. `{ "web": 4000 }`). Overrides must be integers ≥ 1024 and not banned (`22`, `80`, `443`, `10850`), and must not collide with another installed app. A port name not declared by the app is rejected with `400` (see errors). |

```bash
curl -X POST \
  -H "X-Api-Key: admin-key" \
  -H "Content-Type: application/json" \
  -d '{
    "env_vars": { "DATABASE_URL": "postgres://..." },
    "ports": { "web": 4000 }
  }' \
  http://localhost:10850/api/v1/apps/agent-note/reconfigure | jq
```

```json
{ "jobId": "772fa622-a41d-63f6-c938-668877662222" }
```

Poll the returned `jobId` with `GET /api/v1/apps/jobs/:jobId` to track progress. When a host port changes, the proxy route is re-registered and the returned job's `proxyUrls` reflect the new port.

**Rollback on failure:** if a host-port reconfigure fails to recreate the container (e.g. the new port is unbindable or the healthcheck never passes), the app is rolled back to its previous ports — the old compose/`.env` are restored, the old container is brought back up, and the old proxy routes are re-registered — so the app stays reachable. The job is still reported as `failed`.

**Error responses:**

| Status | When |
|--------|------|
| 400 | Neither `env_vars` nor `ports` supplied; a `ports` value is non-integer / banned / `< 1024` / collides with another app; an `env_vars` value is not a string; app source is `local` |
| 403 | Not an admin key |
| 404 | App not installed |
| 409 | App is already being installed / updated / reconfigured |

---

## POST /api/v1/apps/housekeeping {#post-apiv1appshousekeeping}

Reclaim leaked Docker **build cache** and **dangling images** left behind by app install/update (issue #302). The gateway builds/pulls images on every install and update but never reclaimed the build cache or orphaned layers those operations leave, so a long-lived host leaks steadily. This endpoint surfaces and — on request — reclaims that junk, **safely**.

**Body:** `{ "mode": "report" | "prune" }` (default `"report"`).

- **`report`** — read-only. Returns the reclaimable build cache, the dangling-image count, and the orphaned-volume names. Mutates nothing.
- **`prune`** — executes **only the safe reclaim**: `docker builder prune -f --filter until=<window>h` (time-filtered, so a concurrent build's fresh layers survive) and `docker image prune -f` (dangling `<none>` layers only — **never `-a`**). Returns which reclaims ran plus a fresh report.

**Safety floor (always enforced, regardless of config):**

- Never `docker system prune -a`, never `docker image/builder prune -a`.
- **Never** an automatic `docker volume prune` — orphaned volumes can hold real app data, so they are **reported but never auto-deleted**.
- Never touches another app's tagged images.

```bash
# Report only
curl -s -X POST -H "Authorization: Bearer $ADMIN_KEY" \
  -H 'Content-Type: application/json' -d '{"mode":"report"}' \
  http://localhost:10850/api/v1/apps/housekeeping | jq

# Safe prune (build cache + dangling images only)
curl -s -X POST -H "Authorization: Bearer $ADMIN_KEY" \
  -H 'Content-Type: application/json' -d '{"mode":"prune"}' \
  http://localhost:10850/api/v1/apps/housekeeping | jq
```

**Report response:**

```json
{
  "mode": "report",
  "report": {
    "buildCacheReclaimable": "1.457GB",
    "danglingImageCount": 0,
    "orphanVolumes": ["orphan_vol_a", "orphan_vol_b"]
  }
}
```

**Prune response:**

```json
{
  "mode": "prune",
  "pruned": { "buildCache": true, "danglingImages": true },
  "report": { "buildCacheReclaimable": "0B", "danglingImageCount": 0, "orphanVolumes": ["orphan_vol_a"] }
}
```

The same reclaim runs **automatically** after every successful install/update (best-effort — a prune failure never fails the parent operation). It is gated by `gateway.appHousekeeping` in the config:

```jsonc
"gateway": {
  "appHousekeeping": {
    "buildCachePrune": true,        // default on
    "buildCacheMaxAgeHours": 168,   // 7-day window
    "danglingImagePrune": true      // safe subset (no -a)
    // volumes are report-only — no auto-delete key on purpose
  }
}
```

Set all toggles to `false` to make the automatic path issue **zero** prune calls. (The manual `prune` mode above is an explicit operator action and always runs the safe reclaim.)

**Error responses:**

| Status | When |
|--------|------|
| 400 | `mode` is neither `report` nor `prune` |
| 403 | Not an admin key |

---

## App Proxy {#app-proxy}

Installed apps with `ports` declared in their `app.yaml` are accessible at:

```
/app/:appName/:portName/*
```

No gateway auth is required — apps handle their own authentication. Rate limiting is applied per-port as declared in `app.yaml` (`rate_limit` field, default 200 req/s).

Both `:appName` and `:portName` must match `[a-z0-9][a-z0-9-]{1,63}` — requests with names outside this pattern are rejected with `400`.

```
# Example: web app on port 4000 with portName "web"
http://localhost:10850/app/agent-note/web/

# Example: API on port 3000 with portName "api"
http://localhost:10850/app/getpod-manager/api/v1/metrics
```

**Port type behaviour:**

| Type | Path behaviour |
|------|---------------|
| `api` | Strips `/app/:name/:portName` prefix before forwarding |
| `web` | Preserves full original URL path (required for SPAs) |

---

## app.yaml Reference {#appyaml-reference}

Every installable app must include an `app.yaml` at the repository root.

**Minimal example:**

```yaml
apiVersion: "1.0"
name: my-app
version: "1.0.0"
commit: "abc123def456abc123def456abc123def456abc1"
description: "My application"

services:
  app:
    build: .
    ports:
      - name: web
        container: 4000
        host: 4000
        type: web
        rate_limit: 200
```

**Full field reference:**

| Field | Required | Description |
|-------|----------|-------------|
| `apiVersion` | Yes | Always `"1.0"` |
| `name` | Yes | App slug `[a-z0-9][a-z0-9-]{1,63}` |
| `version` | Yes | Semantic version |
| `commit` | Yes | Pinned commit SHA |
| `description` | No | Human-readable description |
| `resources.cpu` | No | CPU limit (default 1.0, max 4.0) |
| `resources.memory` | No | Memory limit e.g. `"256M"`, `"1G"` (max 2G) |
| `services.<name>` | Yes | One or more service definitions |
| `services.agent` | No | Agent service declaration (see below) |

**Service fields:**

| Field | Description |
|-------|-------------|
| `build` | Relative path to Dockerfile directory |
| `image` | Docker image (mutually exclusive with `build`) |
| `command` | Override container command |
| `entrypoint` | Override container entrypoint |
| `environment` | Static env vars (`KEY=value`), secret keys to prompt for (`KEY` without `=`), or self-generating secrets (`KEY=!generate:<encoding>:<bytes>`) |
| `volumes` | Volume mounts (named volumes or host paths within app dir). A relative source must start with `./` and stay inside the app dir — `../` is rejected at parse time, as is any embedded `/../`. **Breaking change:** an app installed before this rule that declares a `../` source can no longer be updated or reconfigured until its manifest is corrected. |
| `ports` | Array of port declarations (see **Port fields** below) |
| `depends_on` | Service dependency list |
| `healthcheck` | Docker healthcheck (test, interval, timeout, retries) |
| `gateway_api` | Host script bridge via Unix socket (see below) |

**Port fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Port identifier used in the proxy path (`/app/:name/:portName`). Unique within the service. |
| `container` | Yes | Port the app listens on **inside** the container. Integer `>= 1024`, not a banned port (`22`, `80`, `443`, `10850`), unique within the service. |
| `host` | Yes | Port exposed on the **host**. Integer `>= 1024`, not a banned port (`22`, `80`, `443`, `10850`), unique within the service. A manifest with a port that has no integer `host` is rejected at install/inspect (`ports["<name>"].host is required and must be an integer`). Default it to the same value as `container`; the installer can override it via the install/reconfigure `ports` field. |
| `type` | No | `api` (strips the `/app/:name/:portName` prefix before forwarding) or `web` (preserves the full path, required for SPAs). |
| `rate_limit` | No | Requests per second for this port (positive number, default 200). |

**Banned fields:** `network_mode: host`, `privileged`, `cap_add`. The gateway always injects `cap_drop: ALL`, `restart: unless-stopped`, `env_file: .env`, and resource limits.

**Self-generating secrets (`!generate`):** An `environment` entry of the form `KEY=!generate:<encoding>:<bytes>` declares a per-install random string. The installer fills it with `crypto.randomBytes(<bytes>)` at install time — the author never hands a value to the installer, and such keys are **not** reported in `secretKeys` (they are never prompted for). Encodings: `hex`, `base64`, `base64url` (URL/connection-string safe — no `+` `/` `=`). Length must be `8`–`512` bytes; an unknown encoding or bad length fails at parse. An explicit `env_vars` value for the key overrides generation. `update` preserves the value already in `.env` (never regenerates). A **local** install also preserves a value already present in the app dir's `.env`: re-installing a local app over a source tree that still holds a prior `.env` keeps the secret stable, so the app can reconnect to persisted data (e.g. a `pgdata` bind mount). A registry/GitHub install always generates fresh (any `.env` checked out from the source is ignored). Precedence: operator-supplied `env_vars` → existing `.env` (local install / update) → generate. Example: `- NEXTAUTH_SECRET=!generate:base64:32`.

**Agent service declaration:**

```yaml
services:
  agent:
    path: ./agent      # relative path to agent workspace within repo
    name: my-agent     # agent ID, must match [a-z][a-z0-9-]{1,63}
```

When declared, the gateway injects a `debian:stable-slim` container, mounts the claude CLI and node binaries, and registers the agent in `config.json`. Messages to this agent are dispatched via `docker exec`.

**Host script bridge (`gateway_api`):**

```yaml
services:
  app:
    gateway_api:
      socket: /var/run/gateway.sock
      scripts:
        resize-disk:
          path: scripts/resize-disk.sh
          timeout: 60s
          args:
            - name: size_gb
              type: string
              pattern: "^\\d+$"
```

The gateway mounts a **directory** (not a socket file) into the container. This means the socket file (`gateway.sock` inside that directory) is stable across gateway restarts — the container's bind mount points to the directory inode, so it always sees the latest socket.

The container connects to `http+unix://<socket>/tool/script/<name>` and POST `{"args": {"size_gb": "20"}}` to invoke a declared script. The gateway only exposes `PATH` and `HOME` to scripts.

**Request body limit:** 1 MB. Requests larger than this are rejected with `413`.

**Arg validation:** Each argument is validated against its declared `pattern` (compiled once at socket startup, not per request). Values exceeding 256 characters are rejected.

---
