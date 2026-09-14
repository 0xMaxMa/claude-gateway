# LINE

LINE connects a Messaging API channel for a LINE Official Account to the gateway through a signed HTTPS webhook. It supports private chats, groups and rooms.

## Create the account and credentials

You need a LINE Business ID, an Official Account you administer, an existing gateway agent, and a public HTTPS webhook URL.

1. Create a LINE Official Account, or open an existing one in **LINE Official Account Manager**.
2. Enable **Messaging API** and choose its provider. This creates the Messaging API channel; new Messaging API channels are no longer created directly in the Developers Console. Follow [LINE's account setup guide](https://developers.line.biz/en/docs/messaging-api/getting-started/).
3. Open that channel in the [LINE Developers Console](https://developers.line.biz/console/). Copy its **Channel secret** from Basic settings.
4. Issue a **Channel access token**. A long-lived token can be issued from the Messaging API tab; LINE also supports token types with expiration; see [channel access tokens](https://developers.line.biz/en/docs/basics/channel-access-token/). The gateway accepts the issued token string, but does not issue or rotate it for you.

The secret verifies incoming messages; the access token sends replies and downloads attachments. A Channel ID cannot replace either credential. See [LINE's bot configuration guide](https://developers.line.biz/en/docs/messaging-api/building-bot/).

## Configure the gateway and webhook

Run `claude-gateway agents update --agent assistant`, select LINE, and supply both credentials. Alternatively, add this fragment to the existing agent configuration and restart with its referenced environment variables available:

```json
{
  "line": {
    "channelAccessToken": "${LINE_CHANNEL_ACCESS_TOKEN}",
    "channelSecret": "${LINE_CHANNEL_SECRET}",
    "dmPolicy": "allowlist",
    "dmAllowlist": [],
    "groupPolicy": "allowlist",
    "groupAllowlist": [],
    "requireMention": true,
    "pairing": true
  }
}
```

The equivalent credential fields for `PATCH /api/v1/agents/:agentId` are `line_channel_access_token` and `line_channel_secret`.

In the channel's Messaging API settings, set the webhook URL to your gateway's public route, for example:

```text
https://gateway.example.com/gateway/webhooks/line/assistant
```

Use the path your proxy actually publishes; a direct gateway host may omit `/gateway`. Click **Verify**, then enable **Use webhook**. Disable the Official Account's automatic reply/greeting messages while testing if they obscure the gateway's reply. LINE requires HTTPS with a trusted certificate. These settings are described in [LINE's webhook setup instructions](https://developers.line.biz/en/docs/messaging-api/building-bot/#set-webhook-url).

Preserve the exact request body and `x-line-signature` header through your proxy. On the bundled tunnel deployment, use the gateway's Bun proxy path rather than bypassing it. A verification success is only a reachability check; test a real signed message next.

## Approve a sender and a group

Add the Official Account as a friend using its QR code and send a private text message. Under the default allowlist policy, the sender receives a one-time pairing code. Open the agent's LINE settings, compare the pending code with the sender, and add their `U...` user ID to `dmAllowlist`. Send another message to verify a reply.

For API administration, read `GET /api/v1/agents/assistant/line/pending` with an admin key, then update `line_dm_allowlist` through the agent PATCH API. These arrays replace the existing list, so include existing approved IDs. The CLI `channels approve` command is for Telegram/Discord only.

For groups, enable the channel's permission to join group chats in the LINE console, invite the bot, then approve the discovered `C...` group ID or `R...` room ID in `groupAllowlist`. The API fields are `line_group_policy`, `line_group_allowlist`, `line_require_mention` and `line_pairing`. Use actual IDs from discovery, never names.

With `requireMention: true`, only a **native LINE mention** of the bot passes. Typing its name or `@All` does not count. Mentions belong to text events: an image, document or audio message in a group cannot satisfy this gate. Use DMs for these attachments or deliberately set `requireMention: false` for allowed groups.

## Messages, voice and commands

Text, images and files are accepted; attachment downloads have a 20 MB cap. Unsupported or unavailable files are identified to the agent rather than presented as a successful download. Stickers, video and location messages are ignored.

With `gateway.orchestration: true` and the agent's [voice configuration](/guide/voice), LINE audio messages can be transcribed. Spoken replies use AAC-LC M4A audio with a scoped HTTPS share URL that expires after 30 minutes; configure a reachable public gateway URL for LINE to fetch that audio. Install `ffmpeg` in the gateway environment for LINE audio conversion. The account's access and group mention gates still apply before audio reaches the agent.

Orchestration chat controls include `/session`, `/sessions`, `/tasks`, `/stop`, `/voice` and `/voices`, with LINE postback controls. `/voice on`, `/voice auto` and `/voice off` select Always, voice-input-only and Off. Voice is disabled for new agents, and each chat's automatic voice replies start Off. Configure `agents[].voice` before enabling them. In private chat, `/model <id or alias>` selects a model from the available catalog and affects the whole agent.

Replies use a LINE reply token first, with push-message fallback when needed. A single-use reply token has a short lifetime, so slow answers may consume the account's push quota. Optional `line.slowResponseThreshold` defaults to 45 seconds: the gateway can send a **Get answer** button, whose tap provides a fresh reply token. Set it to `0` to disable this behavior; `slowButtonLabel` and `slowPendingText` customize its text. Requests are chunked to LINE's five-message-object limit.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Webhook `404` | Agent ID and configured `channelSecret`; public path prefix |
| Webhook `401` | Correct channel secret and unmodified raw body/signature |
| Verify succeeds but no answer | Use webhook enabled, a supported real message sent, pending sender approved |
| Duplicate canned replies | Official Account auto-replies and greeting settings |
| Group text ignored | Bot membership, group allowlist and native mention |
| Group attachment ignored | Attachment cannot carry the native mention required by the default policy |
| Slow reply fails | Reply token expiry, push quota, Get answer button configuration |
| Audio ignored | Gateway orchestration, agent voice/notes settings, `ffmpeg`, access/mention policy |

Implementation references: [LINE webhook](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/api/line-webhook-router.ts), [mention gate](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/api/line-mention.ts), and [reply-token handling](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/agent/line-reply-manager.ts).
