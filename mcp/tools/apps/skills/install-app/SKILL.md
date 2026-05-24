---
name: install-app
description: Install an app from the registry or a GitHub URL. Interactive — shows permissions summary, prompts for env vars, polls to completion, and reports proxy URLs.
user-invocable: true
allowed-tools:
  - mcp__gateway__install_app
  - mcp__gateway__poll_install_job
  - mcp__gateway__browse_registry
---

# /install-app — Install an App Store App

Arguments passed: `$ARGUMENTS`

---

## Argument formats

- `/install-app <registry-name>` — install latest version from registry
- `/install-app <registry-name> <version>` — install specific version
- `/install-app <github-url> <40-hex-commit>` — custom GitHub install (pinned commit)

---

## Step 1 — Resolve the app

**Registry install:** call `browse_registry` with the app name to get its versions list.
Show the user:
- App name and description
- Repo URL
- Version you will install (and whether it is latest)

**GitHub install:** validate that the commit is a 40-char hex string. If not, tell the user
and stop.

If the app is not found in the registry and no GitHub URL given, stop with a helpful message.

---

## Step 2 — Check for required env vars

Call `browse_registry` to get the app definition. If the app has `secretKeys` listed, those
env vars must be supplied. Prompt the user for each missing secret before proceeding:

```
This app requires the following environment variables:
  MY_API_KEY — (no default)
  SOME_TOKEN — (no default)

Please provide values, e.g.:
  MY_API_KEY=xxx
  SOME_TOKEN=yyy
```

Wait for the user's reply. Parse key=value pairs.

If no secrets are needed, proceed immediately.

---

## Step 3 — Show permissions summary

Before installing, show a brief summary:

```
Installing: <app-name> v<version>
Source: <registry|github>
Repo: <url>
Commit: <first 8 chars>
Proxy routes: (from registry metadata if available)
Secrets to inject: <list or "none">

Proceed? (yes/no)
```

Wait for confirmation.

---

## Step 4 — Install

Call `install_app` with the resolved parameters and any collected env vars.

Store the returned `jobId`.

---

## Step 5 — Poll to completion

Poll `poll_install_job` every 3 seconds. Show a brief progress line after each poll
(use the last log entry from the job). Stop when status is `completed` or `failed`.

On **completed**: show proxy URLs from `result.proxyUrls`.
On **failed**: show the error message and last 5 log entries.

---

## Notes

- Never pass branch names as `commit` — only 40-char hex strings are valid.
- `env_vars` values should not be echoed back to the user after collection.
- If the user cancels at any confirmation step, say so and stop.
