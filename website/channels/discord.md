# Discord

Discord connects through the Discord Gateway with a bot token. It supports private messages, guild channels and threads. A public HTTP webhook is not required for message delivery.

## Create an app and obtain the bot token

You need a Discord account, permission to install a bot in a test server, and an existing gateway agent.

1. In the [Developer Portal](https://discord.com/developers/applications), create an application.
2. Open **Bot**. Under **Token**, generate/reset the bot token and copy it securely.
3. On the same page, enable **Message Content Intent** under privileged intents. The receiver needs message content; verified applications may require Discord approval for privileged intents.
4. Configure the application's server installation, including the `bot` scope. Grant **View Channel**, **Read Message History** and **Send Messages**. If you enable automatic threads, also grant **Create Public Threads** and **Send Messages in Threads**.
5. Use the application's installation link to add it to your test server. Check channel permission overrides as well as the server role.

Discord's [getting-started guide](https://docs.discord.com/developers/quick-start/getting-started) covers token creation, intents and installation. The gateway uses the bot token; an Application ID, client secret or public key does not substitute for it.

## Connect and test

Run `claude-gateway agents update --agent assistant` and choose Discord, or add this fragment to the existing agent configuration:

```json
{
  "discord": {
    "botToken": "${DISCORD_BOT_TOKEN}"
  }
}
```

Set the referenced variable in the gateway environment and restart after manual edits. The receiver reads `DISCORD_AUTO_THREAD=true` from its environment to enable automatic thread creation. Although `autoThread` appears in the configuration type, the receiver does not map that JSON field to its environment; use the environment setting. The management API credential field is `discord_bot_token` on `PATCH /api/v1/agents/:agentId`.

DM the bot, allowing direct messages from the shared server if needed. Then approve the request:

```bash
claude-gateway channels pending --agent assistant --channel discord
claude-gateway channels approve --agent assistant --channel discord --code YOUR_CODE
```

Send a second DM to verify a complete reply. For a guild, send a delivered message, inspect the guild pairing request in channel settings/pending, approve it, and test with an explicit bot mention.

## Access rules

Active rules live in `<workspace>/.discord-state/access.json`. Use channel settings or the policy API for routine changes. An explicit policy file can contain:

```json
{
  "dmPolicy": "allowlist",
  "pairing": true,
  "allowFrom": [],
  "groupPolicy": "allowlist",
  "guildAllowlist": [],
  "channelAllowlist": [],
  "roleAllowlist": [],
  "requireMention": true
}
```

Use string Discord user, guild, channel and role IDs, never names. Discord's Developer Mode enables **Copy ID** actions. DM approvals populate `allowFrom`; guild approvals populate `guildAllowlist`. Preserve existing policy and pending entries when editing.

The guild policy runs before optional `channelAllowlist` and `roleAllowlist` filters. Empty optional filter lists add no extra restriction. Those two filters are backend settings without dedicated web controls. The group mention gate accepts an explicit bot mention or reply to the bot. DMs do not use the mention gate.

`discord.dmPolicy`, `dmAllowlist`, `guildAllowlist` and `channelAllowlist` in the agent configuration supply receiver initialization values; inspect the effective `access.json` before changing a running installation. Existing policy files preserve historical behavior during migration: old empty guild allowlists may remain open, and an older policy may not require a mention. New deployments should set their intended policy explicitly. `pairing` is a separate boolean, not a new value of `dmPolicy`.

In an agent session with the Discord access skill, `/gateway:discord-access dm-pairing off` stops inviting unknown DM senders. This is an agent-session command, not a Discord slash-command registration.

## Commands and supported behavior

Use `/help` in a private conversation to discover the receiver's commands. `/model` and `/models` list the available models; `/model <id or alias>` selects a listed model in DMs. Model changes affect the whole agent and restart its sessions, so switching is restricted to direct messages. Guild delivery still requires the bot's permissions and all configured access filters.

## Voice notes and task controls

With `gateway.orchestration: true`, Discord registers native `/voice`, `/voices` and `/tasks` controls alongside session commands. Buttons operate on the current user/session without invoking the model. `/tasks` shows pending work and task-specific stop controls; `/session` and `/sessions` provide direct session management.

Configure [agent voice](/guide/voice) to transcribe audio attachments and generate spoken acknowledgements/replies. `/voice on`, `/voice auto` and `/voice off` choose Always, voice-input-only and Off. Each chat starts Off; enable the agent's voice settings and separately select the desired chat mode. `/voices` selects from the configured provider catalog. Spoken replies are MP3 attachments in the originating channel/thread. Typing continues during queued/running agent or worker activity and stops when only user-input/reconciliation waits remain.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Bot will not connect | Correct bot token; check intent errors in the gateway log |
| Bot online but no useful message content | Enable Message Content Intent in the Developer Portal and reconnect |
| DM works but guild does not | Guild approval, View Channel/Read Message History, channel/role filters and mention gate |
| Receives messages but cannot reply | Send Messages and channel overrides |
| Thread creation/reply fails | `DISCORD_AUTO_THREAD=true` plus Create Public Threads and Send Messages in Threads permissions |
| Policy differs after an upgrade | Review the migrated `.discord-state/access.json`; old behavior is preserved |

Implementation references: [Discord receiver](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/discord/receiver.ts), [access module](https://github.com/0xMaxMa/claude-gateway/blob/b917843/mcp/tools/discord/access.ts), and [configuration types](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/types.ts).
