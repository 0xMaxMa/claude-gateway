---
name: create-app-yaml
description: Scan Dockerfile(s) in the current directory and generate a draft app.yaml for the gateway app store.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(find * -name Dockerfile*)
---

# /create-app-yaml — Generate Draft app.yaml

Arguments passed: `$ARGUMENTS`

Reads Dockerfile(s) in the current working directory and generates a draft `app.yaml`.

---

## Step 1 — Discover Dockerfiles

```bash
find . -name "Dockerfile*" -not -path "*/node_modules/*" -not -path "*/.git/*"
```

List what you found. If none, tell the user and stop.

---

## Step 2 — Infer services

For each Dockerfile, infer:
- **Service name** from the directory name or `Dockerfile.<name>` suffix
- **Exposed ports** from `EXPOSE` instructions — pick the first as the main port
- **Environment variables** from `ENV` instructions — these become `env:` entries
- Whether it looks like a web app (serves HTML/static files) vs an API

---

## Step 3 — Generate app.yaml

Write a draft `app.yaml` to the current directory:

```yaml
apiVersion: apps.getpod.ai/v1
name: <inferred-from-dirname>      # lowercase, hyphens only
version: 1.0.0
commit: ""                          # fill in the 40-char commit hash before release

services:
  <service-name>:
    build: .                        # or ./subdir if not root
    ports:
      - name: <api|web>
        container: <port>
        type: <api|web>             # api = REST/backend, web = serves HTML
        rate_limit: 60              # requests per second
    environment:
      # Secrets (no default value) — users will be prompted at install time
      - MY_SECRET_KEY
      # Variables with defaults
      - LOG_LEVEL=info
    healthcheck:
      test: wget -qO- http://localhost:<port>/health || exit 1
      interval: 30s
      timeout: 10s
      retries: 3
```

Rules for port type:
- `type: web` if Dockerfile serves static HTML, runs Next.js/React/Vite, or uses nginx/caddy
- `type: api` otherwise

Rules for environment variables:
- If the Dockerfile has `ENV FOO=bar` → `FOO=bar` (has default)
- If you see `ARG FOO` or `ENV FOO` with no value → `FOO` (secret, no default)

---

## Step 4 — Show and explain

Show the generated `app.yaml` to the user and explain:
1. They must fill in `commit:` with a 40-char hex commit hash before publishing
2. They can add a `healthcheck:` if the service has a health endpoint
3. If the app has an agent, they can add an `agent:` service block
4. The `rate_limit` is requests per second — adjust to match expected load

---

## Notes

- Never write `network_mode`, `privileged`, or `cap_add` — these are blocked by the gateway
- Do not use floating `:latest` image tags — warn the user to pin versions
- The `commit:` field is intentionally left empty as a placeholder
