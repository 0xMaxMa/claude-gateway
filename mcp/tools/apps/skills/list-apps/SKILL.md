---
name: list-apps
description: List all installed apps with their status, version, and proxy URLs.
user-invocable: true
allowed-tools:
  - mcp__gateway__list_apps
---

# /list-apps — List Installed Apps

Arguments passed: `$ARGUMENTS`

---

Call `list_apps` and format the result as a readable table:

```
Installed Apps
──────────────────────────────────────────────
NAME              VERSION   STATUS    SOURCE
my-app            1.2.0     running   registry
another-app       0.3.1     stopped   custom
──────────────────────────────────────────────
Total: 2 app(s)
```

For each app also show its proxy URLs if it has ports:
```
  Proxy routes:
    api  → /app/my-app/api/
    web  → /app/my-app/web/
```

If no apps are installed, say so clearly.
