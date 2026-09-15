# Slack

Slack connects using an app's Bot User OAuth Token and Signing Secret. The gateway receives signed HTTP Events API requests. Socket Mode is not used.

## Create the Slack app

You need a workspace where you can install apps, an existing gateway agent, and a public HTTPS webhook URL.

1. Open [Your Apps](https://api.slack.com/apps), create an app from scratch, and choose the workspace.
2. Under **OAuth & Permissions**, configure Bot Token Scopes for the features below.
3. Install the app to the workspace, completing any workspace administrator approval. Copy the **Bot User OAuth Token** (`xoxb-...`). Reinstall after changing scopes.
4. Under **Basic Information → App Credentials**, copy the **Signing Secret**.

Use the bot token, not an app-level Socket Mode token or incoming-webhook URL. Slack documents [token types](https://docs.slack.dev/authentication/tokens/) and [request signing](https://docs.slack.dev/authentication/verifying-requests-from-slack/).

| Bot scope | Gateway feature |
| --- | --- |
| `chat:write` | Send replies and controls |
| `im:history` | Receive `message.im` direct-message events |
| `app_mentions:read` | Receive `app_mention` channel events |
| `reactions:write` | Add/remove processing acknowledgements |
| `files:read` | Download attached images and audio |
| `files:write` | Upload outgoing files/voice |
| `users:read` | Resolve display names for pending senders |
| `commands` | Registered slash commands |

Scopes authorize specific platform actions; see Slack's [scope reference](https://docs.slack.dev/reference/scopes/). Grant the features you intend to use, then verify the token's installed scopes if Slack returns `missing_scope`.

## Connect the gateway

Run `claude-gateway agents update --agent assistant`, choose Slack, and enter both credentials. The API validates the token with `auth.test` when saving it. The agent configuration fragment is:

```json
{
  "slack": {
    "botToken": "${SLACK_BOT_TOKEN}",
    "signingSecret": "${SLACK_SIGNING_SECRET}",
    "dmPolicy": "allowlist",
    "dmAllowlist": [],
    "groupPolicy": "allowlist",
    "groupAllowlist": [],
    "requireMention": true,
    "pairing": true
  }
}
```

The corresponding agent PATCH credential fields are `slack_bot_token` and `slack_signing_secret`; provide both together. Manual configuration edits require a restart with the referenced variables in the gateway environment.

In **Event Subscriptions**, enable events and set the Request URL to:

```text
https://gateway.example.com/gateway/webhooks/slack/assistant
```

Adjust `/gateway` for your public proxy path. Disable Socket Mode. Subscribe to bot events `message.im` and `app_mention`, save, and reinstall if prompted. The gateway answers Slack's signed URL-verification challenge. See [Events API setup](https://docs.slack.dev/apis/events-api/using-http-request-urls/).

## Approve the conversation

DM the app. Open its gateway Slack settings, compare the received pairing code with the pending entry, and add the Slack user ID to `dmAllowlist`. Send a second DM to confirm a reply. IDs are stable `U...` values, not display names.

For a channel, invite the app, mention it, then approve that channel's stable ID in `groupAllowlist`. Slack calls this a channel, but the configuration deliberately uses `groupPolicy` and `groupAllowlist`. Under `requireMention: true`, use an explicit app mention. Subscribing only to `app_mention` means ordinary channel messages never arrive even if the gateway mention gate is disabled.

Administrators can inspect `GET /api/v1/agents/assistant/slack/pending`, then PATCH `slack_dm_allowlist` or `slack_group_allowlist` on the agent. Include already approved IDs because these fields replace their arrays. Other policy API fields are `slack_dm_policy`, `slack_group_policy`, `slack_require_mention` and `slack_pairing`. The CLI's Telegram/Discord approval command does not approve Slack users.

## Enable chat controls and voice

With `gateway.orchestration: true`, register these commands under **Slash Commands**, each with the same signed webhook Request URL: `/session`, `/sessions`, `/voice`, `/voices`, `/tasks`, `/stop`, `/help`. Enable **Interactivity & Shortcuts** and set its Request URL to that webhook too, so button actions reach the gateway. Configuring Events API alone does not register slash commands or interactive callbacks.

You can also send `@bot /command` messages through the Events API.

The gateway accepts signed JSON events and Slack's form-encoded slash commands/interactions. Access rules apply to commands too. Session, task and voice controls use Slack Block Kit buttons. `/voice on`, `/voice auto`, `/voice off` choose Always, voice-input-only and Off; `/voices` chooses a voice. These require the agent's [voice setup](/guide/voice); enabling voice does not change the chat's default Off preference.

Images and audio attachments can reach the agent; voice transcription requires orchestration and enabled voice notes. File access needs `files:read`. The connector has no native Slack typing implementation; processing reactions and task controls provide feedback instead.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| URL verification fails | Saved signing secret, exact public route, Socket Mode off, no login redirect |
| Webhook `401` | Raw body/signature headers preserved; system clock within the five-minute replay window |
| `invalid_auth` or `token_revoked` | Correct installed `xoxb-...` token; update after reinstall/revocation |
| DMs work, channel silent | App invited, `app_mention` subscribed, channel approved, explicit mention |
| Text works, file/voice fails | File scopes, audio configuration and provider credentials |
| Slash command unknown | Register it in Slack with the gateway Request URL; enable orchestration |
| Buttons do nothing | Interactivity URL configured; sender has channel access |
| Missing reaction or user label | `reactions:write` or `users:read` scope; reinstall after adding it |

Implementation references: [Slack webhook](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/api/slack-webhook-router.ts), [Slack client](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/api/slack-client.ts), and [access gate](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/api/slack-access.ts).
