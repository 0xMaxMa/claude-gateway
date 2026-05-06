---
name: open-browser
description: "Open a URL in the agent's persistent browser session via MCP browser tools"
user-invocable: true
---

# open-browser

When user says "เปิด X", "navigate to X", "open X in browser", "switch to tab X", etc.

## Rules

- Use ONLY `mcp__gateway__browser_*` tools — never Python, never CDP direct, never filesystem
- NEVER use `wait: "networkidle"` — it hangs on SPAs. Omit `wait` entirely (fire-and-forget)
- Always check tab state before navigating — tab IDs change between sessions
- Do NOT pass `session_id` — it is injected automatically from agent context

## Fast Open Flow

### Step 1 — Create/resume session

Call `mcp__gateway__browser_create_session` with NO arguments (session_id is auto-injected).

Result contains `stream_url` — use it to build the browser URL for the user.

### Step 2 — Send browser URL to user IMMEDIATELY (no waiting)

Reply on Telegram right away with the stream_url so the user can open the browser.

### Step 3 — Check current tabs

Call `mcp__gateway__browser_tabs` — returns list of `{tab_id, url, title}`.

Use this to:
- Know which tab is active / which tab to navigate
- Decide whether to open a new tab or reuse existing one

### Step 4 — Navigate (fire-and-forget)

**Option A — Navigate active tab** (no tab_id):
```
browser_navigate(url)
```

**Option B — Navigate specific tab**:
```
browser_navigate(url, tab_id="t1")
```

**Option C — Open in new tab**:
```
browser_new_tab()  → returns tab_id
browser_navigate(url, tab_id=<new_tab_id>)
```

If `browser_navigate` or `browser_navigate_tab` returns error like `tab "t99" not found (available: [t1, t2])` → call `browser_tabs` again and pick correct tab_id.

### Step 5 — Screenshot and confirm

Call `mcp__gateway__browser_screenshot` — result is absolute file path.

Send to Telegram with the screenshot attached.

## Multi-tab Management

- `browser_tabs` — list all tabs with tab_id, url, title
- `browser_new_tab()` — open new blank tab, returns tab_id
- `browser_navigate(url, tab_id)` — navigate specific tab (optional tab_id)
- `browser_close_tab(tab_id)` — close tab

## Available MCP tools (complete list)

- `browser_create_session` — create/resume session, returns stream_url
- `browser_close_session` — close session
- `browser_get_stream_url` — get stream URL for active session
- `browser_navigate` — navigate to URL; optional tab_id to target specific tab
- `browser_navigate_tab` — navigate specific tab by tab_id (legacy, prefer browser_navigate with tab_id)
- `browser_snapshot` — accessibility tree of current page
- `browser_click` — click element by ref or CSS selector
- `browser_fill` — fill input element
- `browser_type` — type text into focused element
- `browser_evaluate` — run JavaScript in browser
- `browser_scroll` — scroll page
- `browser_wait` — wait for element/networkidle/URL
- `browser_get_text` — get text content of element
- `browser_new_tab` — open new tab, returns tab_id
- `browser_close_tab` — close tab by tab_id
- `browser_tabs` — list all open tabs with tab_id + url + title
- `browser_screenshot` — capture viewport as JPEG, returns absolute file path
