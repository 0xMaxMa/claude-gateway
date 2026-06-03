---
name: create-agent
description: "Create a new Claude Gateway agent — with or without a channel bot"
---

# Create Agent

Create a new Claude Gateway agent. Two modes depending on whether the user wants a chat channel (Telegram/Discord bot) or an API-only agent.

## When to invoke

Invoke this skill when the user says things like:
- "create an agent", "add a new agent", "make an agent called X"
- "I want a new bot for Y"
- "set up an agent that does Z"

---

## Step 1 — Determine mode

Ask the user: does the new agent need a Telegram or Discord bot? 

- **Yes → Channel mode** (MCP tool, requires bot token)
- **No → API-only mode** (REST API, no token needed)

---

## Mode A — Channel mode (Telegram or Discord)

Use `mcp__gateway__agent_create`.

**Required fields to collect:**
| Field | Description |
|-------|-------------|
| `id` | Agent ID — lowercase, letters/digits/`_`/`-`, 2–32 chars, starts with a letter |
| `description` | One paragraph: role, personality, capabilities |
| `channel` | `telegram` or `discord` |
| `bot_token` | Token from BotFather (Telegram) or Discord Developer Portal |

**Optional fields (ask only if user wants to customize):**
| Field | Default | Description |
|-------|---------|-------------|
| `model` | `claude-sonnet-4-6` | Claude model |
| `dm_policy` | `allowlist` | `open`, `allowlist`, or `pairing` |
| `signature_emoji` | none | Emoji sign-off |

**User ID — auto-fill from inbound message context, never ask:**
- `channel=telegram` → set `telegram_user_id` to the sender's `chat_id`
- `channel=discord` → set `discord_user_id` to the sender's user ID
- Never mix Telegram chat_id (6–15 digits) into `discord_user_id` or vice versa

**Generate workspace files automatically** from `id` + `description`:
- `agents_md` — full AGENTS.md (role, rules, capabilities)
- `soul_md` — full SOUL.md (personality, values)
- `user_md` — USER.md (inferred from conversation context)

**Confirm, then call `mcp__gateway__agent_create`.**

After success: agent is live immediately (hot-added). If `dm_policy` is `pairing`, user must start a chat with the bot first. If `allowlist`, only their user ID (already added) can DM it.

---

## Mode B — API-only mode (no bot channel)

Use the REST API directly via curl. Read the admin API key first:

```bash
GATEWAY_KEY=$(jq -r '.gateway.api.keys[] | select(.admin==true) | .key' ~/.claude-gateway/config.json | head -1)
```

**Required fields to collect:**
| Field | Description |
|-------|-------------|
| `id` | Agent ID — same rules as Mode A |
| `description` | One paragraph: role, personality, capabilities |

**Optional:** `model` (default `claude-sonnet-4-6`)

**Call:**
```bash
curl -s -X POST http://localhost:10850/api/v1/agents \
  -H "Authorization: Bearer $GATEWAY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"<id>","description":"<description>","model":"<model>"}'
```

After success: workspace is at `~/.claude-gateway/agents/<id>/workspace/`. The agent has no channel — it can only be reached via API. To add a channel later, use `mcp__gateway__agent_update` with `action: add_channel`.

---

## Notes

- Never fabricate a `bot_token` — always ask the user
- `id` must be unique; if creation fails with "already exists", ask the user to choose a different id
- `dm_policy: open` means anyone who knows the bot can message it — warn the user
- Mode B agents can have a channel added later via `mcp__gateway__agent_update`
