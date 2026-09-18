# Telegram

Telegram uses a bot token and long polling. No public webhook is required for chat delivery. One agent can answer in private chats, groups and supergroups.

## Create the bot and get its token

You need a Telegram account and an existing gateway agent.

1. Open the verified [BotFather](https://t.me/BotFather) account in Telegram.
2. Send `/newbot`, choose a display name, then a unique username ending in `bot`.
3. Copy the issued bot token. It authenticates the bot and must stay private. BotFather can generate a replacement if it is exposed.

These are Telegram's [official bot creation instructions](https://core.telegram.org/bots/tutorial#obtain-your-bot-token).

## Connect the agent

Run `claude-gateway agents update --agent assistant`, select Telegram, and paste the token. For configuration managed as a file, add this fragment to the existing agent:

```json
{
  "telegram": {
    "botToken": "${TELEGRAM_BOT_TOKEN}"
  }
}
```

Supply `TELEGRAM_BOT_TOKEN` to the gateway process environment. The environment variable name is your choice; the `${...}` reference is what connects it to `telegram.botToken`. Manual file edits require a gateway restart. The management API uses `telegram_bot_token` in `PATCH /api/v1/agents/:agentId`; that snake-case field is an API payload field, not the configuration key.

Run only one polling receiver for each bot token. If the bot previously used a webhook, remove that webhook using Telegram's `deleteWebhook` API before starting polling. Telegram does not allow `getUpdates` while a webhook is configured. See [Telegram Bot API delivery methods](https://core.telegram.org/bots/api#getupdates).

## Pair your private chat

Open the bot's Telegram profile, press **Start**, and send a message. For a new agent, the bot sends a six-character pairing code. Approve it from your gateway terminal:

```bash
claude-gateway channels pending --agent assistant --channel telegram
claude-gateway channels approve --agent assistant --channel telegram --code YOUR_CODE
```

Send a second message and confirm that the agent answers. This tests both delivery and access. `/status` reports pairing status. To stop inviting new senders after setup, turn pairing off in channel settings; existing approved senders remain allowed.

## Group setup

1. Add the bot to the group.
2. Ensure Telegram delivers messages: promote the bot to an administrator, or use BotFather's `/setprivacy` to disable Privacy Mode, then remove and re-add the bot. Telegram documents default privacy behavior and administrator exceptions in [bot features](https://core.telegram.org/bots/features#privacy-mode).
3. With `groupPolicy: "allowlist"` and `pairing: true`, send a plain group message. The bot posts a pairing code in the group.
4. Inspect the pending request and approve the code using the CLI above. A group request adds the group ID to `groupAllowlist`.
5. Mention the bot's username or reply to one of its messages to trigger a response when `requireMention` is true.

A message filtered by Telegram cannot initiate pairing. Gateway bot commands are DM-only and are dropped in groups, so use a plain message after configuring delivery. Turning `requireMention` off only helps if Telegram actually delivers all group messages.

## Access configuration

Telegram credentials live in `config.json`; active access rules live at `<workspace>/.telegram-state/access.json`. The normal workspace is `~/.claude-gateway/agents/assistant/workspace`.

```json
{
  "dmPolicy": "allowlist",
  "pairing": true,
  "allowFrom": [],
  "groupPolicy": "allowlist",
  "groupAllowlist": [],
  "requireMention": true
}
```

Use string Telegram user IDs in `allowFrom` and string chat IDs in `groupAllowlist`; obtain them from the pending request or gateway channel settings. Group IDs are usually negative. These are stable IDs, not display names or bot tokens. Preserve existing approvals and pending state when editing an existing file.

`requireMention` is one top-level setting for groups. The receiver rereads access rules on inbound messages. Legacy `dmPolicy: "pairing"` becomes `dmPolicy: "allowlist"` plus `pairing: true`. Older per-group `groups` maps migrate to the flat schema; historical member restrictions may remain in `legacyGroupAllowFrom`. Use the flat schema for new setups.

In an agent session with the Telegram access skill installed, `/telegram:access pair <code>` approves a request, `/telegram:access pairing off` disables invitations, and `/telegram:access group mention <on|off>` changes the mention gate. These are agent-session skill commands, distinct from commands sent to the Telegram bot.

## Private-chat commands

Once paired, use these commands in the bot's private chat:

| Command | Behavior |
| --- | --- |
| `/start`, `/status`, `/help` | Pairing instructions, pairing status, available commands |
| `/session` | Current session name, message count and context usage |
| `/sessions` | List, switch or delete sessions using buttons |
| `/new <name>` | Create a session; name is optional |
| `/rename <name>` | Rename the current session |
| `/clear` | Reset model context after confirmation; history stays unchanged |
| `/compact` | Compact Claude Code context; keep chat history unchanged |
| `/stop` | Interrupt the active turn |
| `/restart` | Confirm a graceful session restart |
| `/model` | Show the current model |
| `/models` | Open the model picker; selecting restarts sessions, Dismiss cancels |

The model list comes from the configured model provider's `/v1/models` catalog when available, with `gateway.models` as fallback. Changing an agent model affects its other chats too.

## Voice notes and background tasks

With `gateway.orchestration: true`, Telegram voice notes and audio attachments can use the agent's configured speech-to-text provider. Enable `agents[].voice` and its `notes` settings first; see [voice setup](/guide/voice) for provider keys, models and prerequisites. Photos and file attachments keep their normal access checks.

In a paired private chat, `/voice` opens Always / Only reply voice message / Off buttons. `/voice on`, `/voice auto` and `/voice off` also set the mode directly. Every chat starts Off, and its choice persists across session switches and gateway restarts. `auto` adds audio to replies originating from voice input and their task results; a later typed instruction makes that turn text-only. `/voices` selects a voice through a paginated provider catalog. Agent voice must be enabled and `voice.notes.replyWithVoice` must permit spoken replies. Voice capability and chat preference are separate settings.

`/tasks` opens the current session's pending work, ten tasks per page. Open a task for status, progress, a pending question or task-specific stop. The browser refreshes automatically; Back and Dismiss do not cancel work or call a model. `/session` and `/sessions` also act as direct gateway controls in orchestration mode. Typing reflects queued inputs, active agent work and workers, stopping when only user-input/reconciliation waits remain. See [orchestration](/guide/orchestration).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `401 Unauthorized` | Token belongs to this bot and has not been revoked; update it after a BotFather reset |
| `409 Conflict` | Another gateway, development process or old deployment is polling the same token; keep one receiver |
| No private reply | Bot was started, request approved, DM policy enabled, agent execution working |
| Private chat works, group silent | Privacy Mode/admin status, remove/re-add after privacy changes, group approval, mention gate |
| `/start` does nothing in a group | Commands are DM-only; pair using a normal delivered group message |
| Missing environment variable at startup | Token variable must exist in the gateway service environment |

Implementation references: [receiver](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/telegram/receiver.ts), [configuration types](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/types.ts), and [access/API handling](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/api/router.ts).
