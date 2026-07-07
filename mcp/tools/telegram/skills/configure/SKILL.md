---
name: configure
description: Set up the Telegram channel — save the bot token and review access policy. Use when the user pastes a Telegram bot token, asks to configure Telegram, asks "how do I set this up" or "who can reach me," or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
---

# /telegram:configure — Telegram Channel Setup

Writes the bot token to `{STATE_DIR}/.env` and orients the user on access policy.
The server reads both files at boot.

Arguments passed: `$ARGUMENTS`

---

## State directory resolution

Compute STATE_DIR at the very start before doing anything else:

```
1. If $TELEGRAM_STATE_DIR env var is set:
     STATE_DIR = $TELEGRAM_STATE_DIR

2. Else if {CWD}/.telegram-state/ exists:
     STATE_DIR = {CWD}/.telegram-state
   (This handles gateway agent sessions where CWD = workspace dir)

3. Else:
     STATE_DIR = ~/.claude/channels/telegram  (legacy fallback)
```

Use STATE_DIR for all file paths:
- Token file: `{STATE_DIR}/.env`
- Access file: `{STATE_DIR}/access.json`

---

## Dispatch on arguments

### No args — status and guidance

Read both state files and give the user a complete picture:

1. **Token** — check `{STATE_DIR}/.env` for
   `TELEGRAM_BOT_TOKEN`. Show set/not-set; if set, show first 10 chars masked
   (`123456789:...`).

2. **Access** — read `{STATE_DIR}/access.json` (missing file
   = defaults: `dmPolicy: "allowlist"`, `pairing: true`, empty allowlist). Show:
   - DM policy (`open`/`allowlist`/`disabled`) and what it means in one line
   - Pairing toggle (on/off) and what it means in one line
   - Allowed senders: count, and list display names or IDs
   - Pending pairings: count, with codes and display names if any

3. **What next** — end with a concrete next step based on state:
   - No token → *"Run `/telegram:configure <token>` with the token from
     BotFather."*
   - Token set, `allowlist` + pairing on, nobody allowed → *"DM your bot on
     Telegram. It replies with a code — approve it from the web Channels card
     (or run `/telegram:access pair <code>` here)."*
   - Token set, someone allowed → *"Ready. DM your bot to reach the
     assistant."*

**The access model.** The base policy should be `allowlist` — only people on
the list reach the assistant. **Pairing** is an orthogonal on/off toggle
(default on) that sits on top of `allowlist`: when on, an unknown sender who
DMs the bot gets a one-time code that shows up in Pending, and the admin
approves it (from the web Channels card, or `/telegram:access pair <code>`).
It's a lightweight identity check, and it's fine to leave on as your standing
way to let new people in. Turn pairing **off** only if you want a hard
allowlist where strangers are dropped silently with no code.

Drive the conversation this way:

1. Read the allowlist. Tell the user who's in it.
2. Ask: *"Is that everyone who should reach you through this bot?"*
3. **If someone's missing** → *"Leave pairing on: have them DM the bot, then
   approve the code that appears in Pending (web card or `/telegram:access
   pair <code>`)."*
4. **If the allowlist is empty and they haven't paired themselves yet** →
   *"DM your bot to capture your own ID first — approve the code and you're
   in."*
5. **If they want a hard lockdown** (no new codes for strangers) → offer to
   run `/telegram:access pairing off`. This keeps `allowlist` but stops
   minting codes; add people later by flipping pairing back on, or with
   `/telegram:access allow <senderId>`.

### `<token>` — save it

1. Treat `$ARGUMENTS` as the token (trim whitespace). BotFather tokens look
   like `123456789:AAH...` — numeric prefix, colon, long string.
2. `mkdir -p {STATE_DIR}`
3. Read existing `.env` if present; update/add the `TELEGRAM_BOT_TOKEN=` line,
   preserve other keys. Write back, no quotes around the value.
4. `chmod 600 {STATE_DIR}/.env` — the token is a credential.
5. Confirm, then show the no-args status so the user sees where they stand.

### `clear` — remove the token

Delete the `TELEGRAM_BOT_TOKEN=` line (or the file if that's the only line).

---

## Implementation notes

- The channels dir might not exist if the server hasn't run yet. Missing file
  = not configured, not an error.
- The server reads `.env` once at boot. Token changes need a session restart
  or `/reload-plugins`. Say so after saving.
- `access.json` is re-read on every inbound message — policy changes via
  `/telegram:access` take effect immediately, no restart.
