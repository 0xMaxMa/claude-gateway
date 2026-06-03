---
name: create-agent
description: "Create a new Claude Gateway agent — collect info from the user and call mcp__gateway__agent_create"
---

# Create Agent

Guide the user through creating a new Claude Gateway agent and call `mcp__gateway__agent_create` when ready.

## When to invoke

Invoke this skill when the user says things like:
- "create an agent", "add a new agent", "make an agent called X"
- "I want a new bot for Y"
- "set up an agent that does Z"

## Step 1 — Collect required information

Ask for any missing required fields. Collect them in a single message if possible.

**Required:**
| Field | Description |
|-------|-------------|
| `id` | Agent ID — lowercase letters, digits, `_`, `-`. 2–32 chars. Must start with a letter. |
| `description` | One paragraph describing the agent's role, personality, and capabilities. |
| `channel` | `telegram` or `discord` |
| `bot_token` | Bot token from BotFather (Telegram) or Discord Developer Portal |

**Optional (ask only if the user wants to customize):**
| Field | Default | Description |
|-------|---------|-------------|
| `model` | `claude-sonnet-4-6` | Claude model to use |
| `dm_policy` | `allowlist` | Who can DM the bot: `open`, `allowlist`, or `pairing` |
| `signature_emoji` | none | Emoji the agent signs off with |

**User ID — do NOT ask, auto-fill from context:**
- If `channel=telegram`: set `telegram_user_id` to the sender's `chat_id` from the inbound message. Never ask the user for this.
- If `channel=discord`: set `discord_user_id` to the sender's user ID from the inbound message. Never ask the user for this.
- This auto-adds the creator to the DM allowlist so they can immediately use the bot.

## Step 2 — Generate workspace files

Once you have `id` and `description`, **generate** `agents_md`, `soul_md`, and `user_md` automatically — do not ask the user to write these.

**`agents_md`** — write a complete `AGENTS.md` covering:
- Agent name and role
- Rules (tone, scope, what to do/not do)
- Capabilities list

**`soul_md`** — write a `SOUL.md` covering:
- Personality and communication style
- Values and priorities

**`user_md`** — write a `USER.md` covering:
- What is known about the user's role, language preference, and context (infer from the conversation)

Base all three on the user's description and conversation context. Make them specific and actionable — generic stubs are not useful.

## Step 3 — Confirm and create

Show the user a brief summary:
```
Agent: <id>
Channel: <channel>
Model: <model>
DM policy: <dm_policy>
Description: <first sentence>
```

Then call `mcp__gateway__agent_create` with all collected and generated fields.

## Step 4 — Report result

After creation succeeds, tell the user:
- The agent is live (no restart needed — hot-added)
- Workspace location: `~/.claude-gateway/agents/<id>/workspace/`
- Next step: if `dm_policy` is `pairing`, they must start a conversation with the bot first to complete pairing; if `allowlist`, only their user ID (already added) can DM it

If creation fails, show the error message and ask the user to correct the relevant field.

## Notes

- Never fabricate a `bot_token` — always ask the user
- `id` must be unique; if creation fails with "already exists", ask the user to choose a different id
- `dm_policy: open` means anyone who knows the bot can message it — warn the user if they choose this
- Never put a Telegram chat_id (6–15 digits) in `discord_user_id`, or a Discord Snowflake (17–19 digits) in `telegram_user_id`
