# Connect a channel

Each agent can connect to multiple channels. A working connection still needs gateway access approval: transport delivery and pairing are separate checks.

## Connect Telegram or Discord

Run the update wizard for an existing agent:

```bash
claude-gateway agents update --agent assistant
```

Choose the channel connection step and provide the bot credentials. The wizard also supports updating or disconnecting Telegram, Discord, LINE, and Slack. Keep credentials in your local configuration or environment files.

For Telegram or Discord, message the bot privately, then review and approve the resulting request:

```bash
claude-gateway channels pending --agent assistant --channel telegram
claude-gateway channels approve --agent assistant --channel telegram --code YOUR_CODE
```

Use `--channel discord` for Discord. Approve only a request you recognize. Verify success by sending another private message and receiving a reply.

## Check platform delivery

| Channel | Connection requirement | First thing to check when silent |
| --- | --- | --- |
| Telegram | Bot token; one long-polling receiver per token | Pairing approval; another poller causes `409 Conflict` |
| Discord | Bot token and Message Content Intent | Intent enabled; View Channel, Read Message History, Send Messages permissions |
| LINE | Access token, channel secret, reachable webhook | Raw request body preserved for signature verification |
| Slack | Configured Slack connection | Agent connection state, platform permissions, and gateway logs |
| WhatsApp linked device | QR or pairing-code link for each account | Account is linked; account-specific DM/group policy |
| WhatsApp Cloud API | Business credentials and signed webhook | Valid signature; DM-only channel |
| WeChat | Personal account linked using QR | iLink polling and DM allowlist; DM-only channel |

For exact connection fields and routes, see the [channel API reference](https://github.com/0xMaxMa/claude-gateway/blob/main/API.md). These platform checks describe the gateway's integration behavior; consult the provider's own console for account setup.

## Bring the bot into a group

First make sure the platform delivers the message. For Telegram, promote the bot to an admin or disable Privacy Mode and remove/re-add it. A plain message can then initiate group pairing. Bot slash commands are DM-only.

Approve the group through the gateway's access controls. With `requireMention: true`, mention or reply to the bot to trigger a response. Discord also checks the guild allowlist and optional channel/role filters. LINE requires a native mention; typing the name or using `@All` is insufficient.

LINE group images/files cannot satisfy its native mention gate. Use a DM or deliberately configure the group to accept messages without a mention. WhatsApp Cloud API and WeChat do not support groups in this integration.

For the complete access schema and platform limitations, see [channel conditions](https://github.com/0xMaxMa/claude-gateway/blob/main/README.md#channel-conditions--limitations).
