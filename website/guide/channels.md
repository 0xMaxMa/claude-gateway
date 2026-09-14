# Connect a channel

An agent can receive conversations from several platforms. Connect the platform first, then approve the people or groups allowed to reach the agent. A valid bot token or linked account does not grant every sender access.

| Guide | What you need | Delivery | Conversations |
| --- | --- | --- | --- |
| [Telegram](/channels/telegram) | BotFather bot token | Long polling | DMs, groups, supergroups |
| [Discord](/channels/discord) | Bot token, intents and server permissions | Discord Gateway | DMs, guild channels and threads |
| [LINE](/channels/line) | Official Account, access token and channel secret | Signed HTTPS webhook | DMs, groups and rooms |
| [Slack](/channels/slack) | App bot token and signing secret | Signed HTTPS Events API | DMs and channel mentions |
| [WhatsApp linked device](/channels/whatsapp) | Phone account and QR or device pairing code | Linked device connection | DMs and groups; multiple accounts |
| [WhatsApp Cloud API](/channels/whatsapp-cloud) | Meta business assets and four credential fields | Signed HTTPS webhook | DMs in this integration |
| [WeChat](/channels/wechat) | Personal account eligible for iLink and a QR scan | iLink long polling | DMs; one account per agent |

## Before you connect

Create an agent and verify that it can answer in the gateway first. See [getting started](/guide/quickstart). You need permission to configure that agent and permission to create or install the platform app. Platform tokens authenticate the bot to its provider; gateway API keys authenticate administrative requests to the gateway. They are different credentials.

For Telegram, Discord, LINE and Slack, run:

```bash
claude-gateway agents update --agent assistant
```

Choose the channel connection step and enter the credentials requested. The same wizard can update or disconnect these four channels. WhatsApp device linking and WeChat use their link controls/API; WhatsApp Cloud credentials are configured in agent settings or the agent configuration.

The JSON examples in the platform guides are **fragments of an existing `agents[]` entry** in `~/.claude-gateway/config.json` (or your `GATEWAY_CONFIG` file). Keep the entry's `id`, `workspace`, `env`, `claude` and other settings. `${VARIABLE}` interpolation reads the **gateway process environment**; exporting a variable only inside an agent session does not make it available to the configuration loader. Arrange for your service/container to load those variables, then restart the gateway after manual configuration edits. A missing interpolated variable can cause the affected agent to be skipped at startup.

## Approve access

New channel policies are closed by default. `dmPolicy` and, where supported, `groupPolicy` use `open`, `allowlist` or `disabled`. `pairing` is a separate boolean: when enabled under an allowlist policy, a denied sender can receive a code for the administrator to recognize. Turning pairing off keeps the allowlist active and stops new pairing invitations. A disabled policy stays disabled even when pairing is on.

Telegram and Discord have approval queues:

```bash
claude-gateway channels pending --agent assistant
claude-gateway channels approve --agent assistant --channel telegram --code YOUR_CODE
claude-gateway channels deny --agent assistant --channel discord --code YOUR_CODE
```

Only approve requests you recognize. Telegram/Discord store their active policies in the workspace's channel `access.json` files. Older files may preserve older behavior, so inspect the effective settings rather than assuming new-agent defaults.

LINE, Slack, WhatsApp and WeChat instead expose **pending sender discovery**. Compare the code with the sender, then add their stable sender or group ID to the appropriate allowlist in channel settings. The CLI `channels approve` command does not support these platforms. Removing a pending row only dismisses discovery; it does not approve the sender.

## Publish a webhook

LINE, Slack and WhatsApp Cloud need a public HTTPS URL that reaches the gateway's `/webhooks/{app}/{agentId}` route. For a deployment published under `/gateway`, a LINE URL is:

```text
https://gateway.example.com/gateway/webhooks/line/assistant
```

A direct host without that prefix uses `/webhooks/line/assistant`. Preserve your deployment's actual proxy path, and include the agent ID to avoid routing to the first configured agent. `gateway.publicUrl` describes the public gateway base; setting it does not create DNS, TLS or a tunnel.

Webhook ingress bypasses gateway API-key authentication because providers authenticate requests with their own signatures. Keep the signed body and signature headers intact, and configure the reverse proxy so these routes do not redirect providers to a login page. All management APIs remain authenticated. See the [API reference](/api/webhooks).

## Orchestration and voice

`gateway.orchestration: true` enables managed conversations and background tasks across every connected channel. Voice providers and models are configured per agent under `agents[].voice`. Telegram, Discord, LINE and Slack support voice notes, spoken replies and chat controls; see [orchestration](/guide/orchestration) and [voice setup](/guide/voice). WhatsApp and WeChat retain their adapter-specific media limits.

## Diagnose a silent bot

Check these in order:

1. **Connection:** valid token or linked account; gateway and agent running.
2. **Delivery:** polling conflict, Discord permissions/intents, or webhook reachability and signature.
3. **Access:** sender/group allowlist, policy and pairing status.
4. **Mention:** group mention requirement and the provider's ability to deliver that message.
5. **Execution/reply:** agent credentials, provider response errors, media limits and quotas.

Each guide gives platform-specific checks and a first-message test. For gateway logs and process problems, continue to [troubleshooting](/guide/troubleshooting).
