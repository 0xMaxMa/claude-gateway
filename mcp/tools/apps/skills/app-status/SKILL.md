---
name: app-status
description: Show detailed status, version info, and update availability for an installed app.
user-invocable: true
allowed-tools:
  - mcp__gateway__app_status
---

# /app-status — App Status

Arguments passed: `$ARGUMENTS`

---

## Usage

`/app-status <app-name>`

---

## Steps

1. Call `app_status` with the app name.

2. Format and present:

```
App: <name>
Status: running ✓  (or stopped / error / building)
Version: 1.2.0
Commit: abc123de
Source: registry  (or custom / local)
Installed: 2026-05-01T10:00:00Z

Proxy routes:
  api → /app/<name>/api/
  web → /app/<name>/web/

Version info:
  Installed: 1.2.0
  Latest:    1.3.0  ← update available
  Behind: yes
```

3. If an update is available and source is `registry`, offer:
   > Run `/install-app <name>` after uninstalling, or use the update API.

If the app is not found (404), say so clearly.
