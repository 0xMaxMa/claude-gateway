# Package Updates {#package-updates}

Endpoints for checking and installing newer versions of `@0xmaxma/claude-gateway` and `@anthropic-ai/claude-code`. All package endpoints require an **admin** API key (`admin: true` in config).

---

## GET /api/v1/packages {#get-apiv1packages}

Returns the current and latest version for both packages. Result is cached for 5 minutes to avoid hammering the npm registry.

`latest` is read from the npm registry for both packages. `current` is resolved per package: `claude-gateway` (an npm global) via `npm list -g`, and `claude-code` (native installer) from the installed binary (`claude --version`). If Claude Code is not installed, its `current` is `null` and the UI renders `—`. `hasUpdate` is `true` only when `latest` is strictly newer than `current` by semver ordering, so a binary that is *ahead* of the registry `latest` does not report a spurious update.

```bash
curl -H "X-Api-Key: admin-secret" \
  http://localhost:10850/api/v1/packages | jq
```

```json
{
  "packages": [
    {
      "package": "@0xmaxma/claude-gateway",
      "current": "1.2.0",
      "latest": "1.3.1",
      "hasUpdate": true
    },
    {
      "package": "@anthropic-ai/claude-code",
      "current": "1.0.5",
      "latest": "1.1.0",
      "hasUpdate": true
    }
  ]
}
```

**Error responses:**

| Status | When |
|--------|------|
| 401 | No API key provided |
| 403 | Non-admin API key |
| 503 | npm registry unreachable |

---

## POST /api/v1/packages/:name/update {#post-apiv1packagesnameupdate}

Installs the latest version of the specified package. `:name` accepts `claude-gateway` or `claude-code`.

- **claude-gateway**: runs `npm install -g @0xmaxma/claude-gateway@latest` then sends itself `SIGTERM`, requesting a non-zero (`EX_TEMPFAIL`) exit code so a `Restart=on-failure` unit restarts it too — a graceful `exit(0)` reads as success to `on-failure` and never restarts (issue #450). `Restart=always` units and pm2's `autorestart` restart on any exit code regardless.
- **claude-code**: runs the native updater (`claude update`) so the actual binary on PATH is updated. No restart needed. (npm install is not used — Claude Code ships via the native installer, so an npm-global copy would not be the running binary.)

If the package is already on the latest version the call is a no-op (`updated: false`).

```bash
curl -X POST \
  -H "X-Api-Key: admin-secret" \
  http://localhost:10850/api/v1/packages/claude-gateway/update | jq
```

```json
{
  "package": "@0xmaxma/claude-gateway",
  "from": "1.2.0",
  "to": "1.3.1",
  "updated": true,
  "warning": "service will restart"
}
```

`warning` values:

| Value | Meaning |
|-------|---------|
| `"service will restart"` | Running under systemd or pm2 — process manager will auto-restart |
| `"process will stop — restart manually"` | Plain process (dev) — will exit after update |
| `null` | No restart needed (claude-code) |

**Error responses:**

| Status | When |
|--------|------|
| 401 | No API key provided |
| 403 | Non-admin API key |
| 404 | Unknown package name |
| 500 | `npm install` failed — body contains stderr |
| 503 | npm registry unreachable |
