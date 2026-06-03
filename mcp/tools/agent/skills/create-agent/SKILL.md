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
| `telegram_user_id` | — | Auto-add the user to the DM allowlist (Telegram only) |

## Step 2 — Generate workspace files

Once you have `id` and `description`, **generate** `agents_md` and `soul_md` automatically — do not ask the user to write these.

**`agents_md`** — write a complete `AGENTS.md` covering:
- Agent name and role
- Rules (tone, scope, what to do/not do)
- Capabilities list

**`soul_md`** — write a `SOUL.md` covering:
- Personality and communication style
- Values and priorities

Base both on the user's description. Make them specific and actionable — generic stubs are not useful.

## Step 3 — Confirm and create

Show the user a brief summary:
```
Agent: <id>
Channel: <channel>
Model: <model>
DM policy: <dm_policy>
Description: <first sentence>
```

Then call `mcp__gateway__agent_create` with all collected fields.

## Step 4 — Report result

After creation succeeds, tell the user:
- The agent is live (no restart needed — hot-added)
- How to find it: the agent workspace is at `~/.claude-gateway/agents/<id>/workspace/`
- Next step: if `dm_policy` is `pairing` or `allowlist`, they need to pair or add their user ID

If creation fails, show the error message and ask the user to correct the relevant field.

## Notes

- Never fabricate a `bot_token` — always ask the user
- `id` must be unique; if creation fails with "already exists", ask the user to choose a different id
- `dm_policy: open` means anyone who knows the bot can message it — warn the user if they choose this
