---
name: install-app
description: Install an app from the registry or a GitHub URL. Interactive — shows permissions summary, prompts for env vars, polls to completion, and reports proxy URLs.
user-invocable: true
allowed-tools:
  - mcp__gateway__install_app
  - mcp__gateway__inspect_app
  - mcp__gateway__poll_install_job
  - mcp__gateway__browse_registry
---

# /install-app — Install an App Store App

Arguments passed: `$ARGUMENTS`

---

## Argument formats

- `/install-app <registry-name>` — install latest version from registry
- `/install-app <registry-name> <version>` — install specific version
- `/install-app <github-url>` — custom GitHub install (installs the latest commit on the default branch)
- `/install-app <github-url> <40-hex-commit>` — custom GitHub install pinned to a specific commit

---

## Step 1 — Resolve the app

**Registry install:** call `browse_registry` with the app name to get its versions list.
Show the user:
- App name and description
- Repo URL
- Version you will install (and whether it is latest)

**GitHub install:** the commit is **optional**.
- If the user supplied a commit, validate it is a 40-char hex string; if it is malformed,
  tell the user and stop.
- If **no commit** was given, do **not** ask the user to find one — call `install_app` with
  just the `github_url` and the installer resolves the default branch's latest commit (HEAD)
  automatically and pins it. Report the resolved commit in Step 5.

If the app is not found in the registry and no GitHub URL given, stop with a helpful message.

---

## Step 2 — Check for required env vars

Call `inspect_app` with the same source you will install (`github_url` [+ `commit`],
`registry_app` [+ `version`], or `local_path`). It fetches and parses the app's
`app.yaml` **without installing** and returns the real secret requirements:

- `secretKeys` — env vars the operator **must** supply (no default). Prompt for
  each one before proceeding.
- `generatedKeys` — secrets the gateway **auto-generates** at install time
  (declared as `KEY=!generate:...`). Do **not** prompt for these; just note they
  will be generated.
- `secretDefaults` — defaults for prompt-with-default secrets (declared as
  `KEY=!default:<value>`). These keys still appear in `secretKeys`, so prompt for
  them — but **pre-fill the default** and tell the user they can keep it. If they
  leave it blank, the default is written to `.env` (operator value → default →
  empty).

This is essential for a **GitHub-URL** install: such apps have no registry entry,
so `browse_registry` cannot reveal their secrets — only `inspect_app` can.

If `inspect_app` reports `secretKeys`, prompt the user for each (showing the
default from `secretDefaults` when one exists):

```
This app requires the following environment variables:
  MY_API_KEY — (no default)
  SOME_TOKEN — (no default)
  NEXTAUTH_URL — default: http://localhost:3737 (press enter to keep)

Please provide values, e.g.:
  MY_API_KEY=xxx
  SOME_TOKEN=yyy
```

Wait for the user's reply. Parse key=value pairs. For a key with a default, an
omitted or blank value means "use the default" — do not send an empty string
expecting the app to fail.

If `secretKeys` is empty (only `generatedKeys`, or no secrets at all), proceed
immediately — do not invent secrets or ask for ones the app did not declare.

> If `inspect_app` fails (e.g. the repo is unreachable), tell the user the error
> and stop — do not fall back to assuming "no secrets".

---

## Step 3 — Show permissions summary

Before installing, show a brief summary (use the `name`, `version`, `ports`,
`secretKeys`, and `generatedKeys` returned by `inspect_app`):

```
Installing: <app-name> v<version>
Source: <registry|github>
Repo: <url>
Commit: <first 8 chars, or "latest on default branch (auto-resolved)" for a GitHub install with no pinned commit>
Proxy routes: <from inspect_app ports, or "none">
Secrets to provide: <secretKeys the user supplied, or "none">
Secrets auto-generated: <generatedKeys, or "none">

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

On **completed**: show proxy URLs from `result.proxyUrls`. For a GitHub install with no
pinned commit, also report the commit that was resolved and installed (the job logs a
`Resolved HEAD → <short>` line) so the user knows exactly what was pinned.
On **failed**: show the error message and last 5 log entries.

---

## Notes

- The `commit` is optional for GitHub installs; when omitted the installer pins the latest
  commit on the default branch. When a commit **is** supplied it must be a 40-char hex string
  — never pass a branch name as `commit`.
- `env_vars` values should not be echoed back to the user after collection.
- If the user cancels at any confirmation step, say so and stop.
