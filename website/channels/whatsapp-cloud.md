# WhatsApp Cloud API

This channel uses Meta's WhatsApp Business Cloud API with bearer-token requests and signed webhooks. The gateway integration handles direct messages. It is configured independently of the [WhatsApp linked-device bridge](/channels/whatsapp).

## Obtain business credentials

You need a Meta developer account, business portfolio, WhatsApp Business Account (WABA), a business phone number or Meta test number, and a public HTTPS gateway URL.

1. Create/configure a Meta app with the WhatsApp product/use case. Open its WhatsApp API setup panel.
2. For testing, select the test number and permitted recipient. Copy the access token and **Phone Number ID**.
3. For continued operation, create a system-user access token with access to the business assets and the required `whatsapp_business_messaging` / `whatsapp_business_management` permissions. A short-lived test token will expire.
4. Copy the app's **App Secret** from its settings. Generate your own random **Verify Token** for the webhook handshake; it is not the access token.

Meta's [official Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api) describes assets, tokens, permissions, phone-number registration and WABA subscription. Finish the number's registration and app/WABA subscription before testing inbound delivery.

## Map credentials to the gateway

Add this fragment to the existing agent configuration:

```json
{
  "whatsapp_cloud": {
    "accessToken": "${WHATSAPP_CLOUD_ACCESS_TOKEN}",
    "phoneNumberId": "${WHATSAPP_CLOUD_PHONE_NUMBER_ID}",
    "appSecret": "${WHATSAPP_CLOUD_APP_SECRET}",
    "verifyToken": "${WHATSAPP_CLOUD_VERIFY_TOKEN}",
    "dmPolicy": "allowlist",
    "dmAllowlist": [],
    "pairing": true,
    "sendReadReceipts": true,
    "reactionLevel": "ack",
    "templatesEnabled": false
  }
}
```

Supply these variables to the gateway environment and restart after a manual edit. `phoneNumberId` is Meta's ID for the sending number, not its digits, the WABA ID or App ID.

The agent PATCH API accepts `whatsapp_cloud_access_token`, `whatsapp_cloud_phone_number_id`, `whatsapp_cloud_app_secret` and `whatsapp_cloud_verify_token`. Send all four together when connecting/updating credentials. The CLI's four-platform connection wizard does not include this channel.

## Configure the webhook

In Meta's WhatsApp/webhook settings, set the callback URL to your published gateway route:

```text
https://gateway.example.com/gateway/webhooks/whatsapp_cloud/assistant
```

Adjust the `/gateway` prefix for your proxy. Enter the same Verify Token as `verifyToken`, complete verification, and subscribe to `messages` notifications for the WABA/app. The handshake compares `hub.verify_token`; actual deliveries require `X-Hub-Signature-256`, computed from the exact raw request body using `appSecret`.

Keep the signature header and body intact through the proxy. A successful GET verification does not prove POST messages are delivered, so send a real message next.

## Approve the first sender

Message the business number from a permitted test recipient or real customer account. In the gateway's WhatsApp Cloud settings, compare the pending sender's code and approve their number in `dmAllowlist`. Use international **bare digits without `+`**, spaces or JID suffixes. Then send another message and verify a response.

For administrators, `GET /api/v1/agents/assistant/whatsapp_cloud/pending` lists denied senders. PATCH `whatsapp_cloud_dm_allowlist` on the agent to replace the allowlist, preserving existing entries. Policy fields are `whatsapp_cloud_dm_policy` and `whatsapp_cloud_pairing`. The Telegram/Discord `channels approve` CLI does not apply here.

There are no `groupPolicy`, `groupAllowlist` or `requireMention` fields for this integration.

## Messages and templates

The gateway normalizes text, images, supported documents, stickers, locations, contact data, and interactive button/list selections. Downloaded media is capped at 20 MB. Quoted-message context contains the referenced message ID; Meta does not include the original quoted text in this event. Audio/video ingestion and channel voice controls are not implemented here. Gateway [orchestration](/guide/orchestration) still applies to supported conversations.

Free-form replies depend on the 24-hour customer-service window following the user's latest message. Outside the window, use a Meta-approved message template. The gateway keeps `templatesEnabled: false` by default; explicitly enable it only when template sending is intended, then use an approved template name/language. Enabling the setting does not create or approve templates in Meta. Read receipts default on; `reactionLevel` is `ack` or `off`.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Webhook verification fails | Matching Verify Token, HTTPS callback route and explicit agent ID |
| POST returns `401` | Correct App Secret, signature present, raw bytes preserved |
| Verification passes but messages absent | `messages` subscription, WABA/app subscription, correct business number |
| Outbound authentication fails | Expired test token, system-user asset assignment and token permissions |
| Sender never approved | Bare-digit allowlist format and pending entry for `whatsapp_cloud` |
| Text reply refused outside service window | Approved template and `templatesEnabled`; inspect Meta's returned error |
| Templates still rejected | Exact approved template name/language and correct business account |

Implementation references: [Cloud webhook](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/api/whatsapp-cloud-webhook-router.ts), [Cloud client](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/api/whatsapp-cloud-client.ts), and [access gate](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/api/whatsapp-cloud-access.ts).
