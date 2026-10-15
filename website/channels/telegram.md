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

A message filtered by Telegram cannot initiate pairing, and neither can a command: use a plain message after configuring delivery. Turning `requireMention` off only helps if Telegram actually delivers all group messages.

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
| `/session` | Current session name, selected model and measured context usage |
| `/sessions` | List, switch or delete sessions using buttons |
| `/new <name>` | Create a session; name is optional |
| `/rename <name>` | Rename the current session |
| `/clear` | Reset model context after confirmation; history stays unchanged |
| `/compact` | Compact Claude Code context; keep chat history unchanged |
| `/stop` | Interrupt the active turn |
| `/restart` | Confirm a graceful session restart |
| `/model` | Show the current model (view only; an argument is ignored). Switch with `/models` |
| `/models` | Open the model picker; selecting restarts sessions, Dismiss cancels |
| `/pstack_setup` | Set up [pstack](/guide/pstack) for this agent with buttons (direct message); `/pstack_setup <lines>` types the change |
| `/call` | Start a live voice call in a Mini App (orchestration and agent voice required); see [live voice calls](#live-voice-calls) |

In an approved group, `/stop`, `/new`, `/rename` and `/pstack_setup` (which only answers that it works in a direct message, so the agent's setup is not posted in the group) are answered there, typed as `/command` or `/command@<bot>` without a separate mention. The other commands reply in the group that they are only available in a direct message with the bot (`/cli` only where the terminal viewer is on). A group that is not approved, a bot whose `dmPolicy` is `disabled`, or a command addressed to another bot gets no reply.

The model list comes from the configured model provider's `/v1/models` catalog when available, with `gateway.models` as fallback. Changing an agent model affects its other chats too.

## Long messages

Telegram splits a text longer than 4096 characters into several messages. With `gateway.orchestration: true`, the agent answers them as one message. Without `conversation.semanticIntake`, Telegram cuts each part after at least half the limit, so after a part of 1984 or more characters the gateway waits up to `conversation.inputDebounceMs` (default 1500 ms) for the next part, and at most `inputMaxWaitMs` from the first one. Shorter messages start immediately. Only the first part carries a reply, so a continuation without one joins it; parts replying to different messages stay separate. With `semanticIntake`, consecutive messages are combined as described in [orchestration](../guide/orchestration.md), and parts must reply to the same message. Commands and voice notes are never combined. See [conversation processing settings](../reference/orchestration-settings.md#conversation-processing).

## Voice notes and background tasks

With `gateway.orchestration: true`, Telegram voice notes and audio attachments can use the agent's configured speech-to-text provider. Enable `agents[].voice` and its `notes` settings first; see [voice setup](/guide/voice) for provider keys, models and prerequisites. Photos and file attachments keep their normal access checks.

If a voice note cannot be transcribed for a temporary reason, the failure reply in a private chat has a **🔁 Retry** button that transcribes the kept recording again. See [Voice-message failures and retry](../guide/voice.md#voice-message-failures-and-retry).

### Live voice calls (`/call`) {#live-voice-calls}

In a paired private chat, `/call` sends a **🎙 Start voice call** button that opens a Telegram Mini App. The call starts as the Mini App opens; allow the microphone, or tap **Start call** if the app asks for a tap first (Telegram for Android does). The call screen shows the bot's Telegram name and profile photo (or its initial when the bot has none) and a call clock that counts through reconnects. A name or photo changed in BotFather shows on the next call. Its round buttons are **Speaker** (turns the agent's voice on or off; replies still appear as text), **End call** and **Mute**. Mute sends what you just said: the agent answers it right away, without waiting for you to pause, and its reply still plays while your microphone is off. With nothing said since the last reply, Mute only turns the microphone off. A web page cannot choose between the earpiece and the loudspeaker; the phone picks the output. The status under the clock shows **Listening**, **Thinking** as soon as you stop speaking (speak again before the answer and it returns to Listening), **Speaking** while the agent talks, and **Muted**. The call screen follows Telegram's light or dark theme, switches with it during a call, and uses the system setting when opened outside Telegram. The agent speaks with the voice you chose with `/voices` in this chat, the same voice as its voice messages; without a choice it uses the agent's configured voice. A voice chosen during a call applies from the next call. You then talk with the agent and can interrupt it by speaking. The call joins this chat's active session: each thing you say is shown in the chat as a `🎙 <your words>` line above the agent's text reply, and tools follow the same `allow_tools` rule as typed messages (spoken turns never write memory). A reply you heard in the call is not sent again as a voice message, even with `/voice on`. Typing in the chat during a call interrupts the spoken reply, and the typed reply is spoken in the call instead of being sent as a voice message. Switching sessions (`/new`, `/sessions`) ends the call's turns; send `/call` again.

`/call` needs `gateway.orchestration: true` with `telegram` among the agent's orchestration channels, `agents[].voice.enabled` with STT/TTS providers, and an `https://` `gateway.publicUrl` (Telegram opens Mini Apps only over HTTPS). It works only in a private chat; in a group the bot answers that it is only available in a direct message. Group calls are not supported yet. The link works for about three minutes; once a call starts it can reconnect for 30 minutes after its last connection. Each **Start voice call** button opens one call: tapping an older button, or one whose link expired, shows only "This call link was already used" or "This call link has expired" with nothing started; send `/call` again. Reloading the open call page rejoins its own call. Hiding the Mini App pauses the call: it leaves the voice connection, so replies arrive in the chat as usual (as voice messages too if `/voice` is on), and returning rejoins the call. When you hang up, or a dropped call is not rejoined within a minute, the chat gets a `📞 Call ended · 3:42` message with the call's length. Sent in a private-chat topic, the call joins that topic. See [Telegram voice calls](../api/voice.md#telegram-voice-calls) for the protocol.

On a GetPod pod, `/call` signs in like `/cli`: the first time the Mini App opens, the pod asks you to sign in to GetPod (for example with Google) and then returns to the call page. If that sign-in expires during a call, the page shows **Sign in again**; tap it and sign in, and the call starts again.

In a paired private chat, `/voice` opens Always / Only reply voice message / Off buttons. `/voice on`, `/voice auto` and `/voice off` also set the mode directly. Every chat starts Off, and its choice persists across session switches and gateway restarts. `auto` adds audio to replies originating from voice input and their task results; a later typed instruction makes that turn text-only. `/voices` selects a voice through a paginated provider catalog; the choice applies to this chat's voice messages and its `/call` calls. Agent voice must be enabled and `voice.notes.replyWithVoice` must permit spoken replies. Voice capability and chat preference are separate settings.

`/tasks` opens the current session's pending work, ten tasks per page. Open a task for status, progress, a pending question or task-specific stop. The browser refreshes automatically; Back and Dismiss do not cancel work or call a model. `/session` shows the selected model and measured context usage. Its message refreshes every three seconds when values change. Calling `/session` again replaces the previous status message at the bottom of the chat; switching sessions retires the old status message. `/session` and `/sessions` also act as direct gateway controls in orchestration mode. Typing reflects queued inputs, active agent work and workers, stopping when only user-input/reconciliation waits remain. See [orchestration](/guide/orchestration).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `401 Unauthorized` | Token belongs to this bot and has not been revoked; update it after a BotFather reset |
| `409 Conflict` | Another gateway, development process or old deployment is polling the same token; keep one receiver |
| No private reply | Bot was started, request approved, DM policy enabled, agent execution working |
| Private chat works, group silent | Privacy Mode/admin status, remove/re-add after privacy changes, group approval, mention gate |
| A command in a group only says to use a direct message | Expected: these commands work in the bot's private chat. In a group that is not approved yet the bot stays silent; pair it with a plain group message |
| `/call` says voice calls are not configured | Set an HTTPS `gateway.publicUrl`; enable `agents[].voice` and Telegram orchestration |
| Voice call page says to sign in again | The pod's sign-in expired or another account is signed in; tap **Sign in again**, sign in with the pod owner's account |
| Voice call page says the link was already used or has expired | The button belongs to an earlier or expired call; send `/call` for a new button |
| Voice call page cannot use the microphone | Update Telegram; allow microphone access for Telegram in the system settings; some desktop clients deny it without a prompt |
| Missing environment variable at startup | Token variable must exist in the gateway service environment |

Implementation references: [receiver](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/telegram/receiver.ts), [configuration types](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/types.ts), and [access/API handling](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/api/router.ts).
