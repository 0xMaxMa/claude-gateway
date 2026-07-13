---
name: discord-configure
description: Configure the Discord channel — save bot token, set auto-thread, embed options.
user-invocable: true
---

# /gateway:discord-configure — Configure Discord

Use this skill to set up the Discord channel for an agent.

## Required setup

### 1. Save the bot token
```
/gateway:discord-configure token <BOT_TOKEN>
```
Writes `DISCORD_BOT_TOKEN=<token>` to `$DISCORD_STATE_DIR/.env`.

### 2. Set required env vars in agent config
Add to the agent's `.env` file:
```
DISCORD_BOT_TOKEN=<your-bot-token>
DISCORD_STATE_DIR=~/.claude-gateway/agents/<id>/.discord-state
DISCORD_DM_POLICY=disabled        # open | allowlist | disabled
DISCORD_GUILD_ALLOWLIST=          # comma-separated guild IDs (empty = all)
DISCORD_CHANNEL_ALLOWLIST=        # comma-separated channel IDs (empty = all)
DISCORD_AUTO_THREAD=false         # create thread per conversation
DISCORD_USE_EMBEDS=false          # use embeds for long responses
```

## Discord Developer Portal checklist

1. Go to https://discord.com/developers/applications
2. Select your application → Bot settings
3. Enable **MESSAGE CONTENT INTENT** (privileged intent) — **required**: without
   it the bot still receives message events but with **empty content**, so it can
   neither respond nor pair. This is the #1 cause of a bot that joins a server but
   stays silent.
4. Required bot permissions:
   - View Channel *(and Read Message History — without these the bot never sees messages in the channel)*
   - Send Messages
   - Read Message History
   - Create Public Threads
   - Send Messages in Threads
   - Attach Files
   - Embed Links
   - Add Reactions
   - Use Application Commands

> **Scope note.** DMs and guilds are gated separately: DMs by `dmPolicy` +
> `pairing`, guilds by `groupPolicy` + `guildAllowlist` + `requireMention` (see
> `/gateway:discord-access`). The intent and permissions above are the
> platform-level prerequisites — the access lists only matter once messages
> actually reach the bot.

## Implementation

Parse the subcommand and act accordingly:
- `token <value>` — write `.env` file to DISCORD_STATE_DIR
- `show` — display current env vars (mask the token)
- `check` — verify the bot can connect (call discord_reply to a test channel if provided)

Confirm each action and display what was changed.
