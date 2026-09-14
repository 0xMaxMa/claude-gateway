# WhatsApp linked device

This channel links a WhatsApp account through the Baileys WhatsApp Web bridge. It supports DMs and groups, with multiple numbers per agent. For Meta-issued business credentials and signed webhooks, use the separate [WhatsApp Cloud API guide](/channels/whatsapp-cloud).

## Prerequisites and credentials

You need a WhatsApp account on a phone you control, access to its **Linked devices** settings, and an existing gateway agent. No developer API key, Meta App Secret or webhook URL is required: the linked device session is the credential.

The gateway uses an unofficial bridge. Its connect flow discloses account restriction/ban risk; review that before linking a number. The official [WhatsApp device-link instructions](https://faq.whatsapp.com/1317564962315842/) explain the phone-side QR process, but do not make Baileys an official WhatsApp integration.

## Configure an account

Each entry in `whatsapp.accounts` represents one linked number and its own policy:

```json
{
  "whatsapp": {
    "accounts": [
      {
        "id": "default",
        "label": "Assistant line",
        "dmPolicy": "allowlist",
        "dmAllowlist": [],
        "groupPolicy": "allowlist",
        "groupAllowlist": [],
        "requireMention": true,
        "pairing": true,
        "sendReadReceipts": true,
        "reactionLevel": "ack"
      }
    ]
  }
}
```

Add this to your existing agent entry, keeping the other fields. Use stable filesystem-safe account IDs; do not reuse an ID for another number. An absent/empty account array resolves to the compatibility `default` account. Older flat WhatsApp configuration is migrated to an accounts array.

The `default` account's linked credentials live in `<workspace>/.whatsapp-state/`; other accounts use `<workspace>/.whatsapp-state/<accountId>/`. Preserve these directories across gateway restarts. They are sensitive account sessions, not ordinary cache files.

## Link by QR or device pairing code

Open the agent's WhatsApp connection settings, select the account slot, and start linking. On the phone, open **Linked devices → Link a device**, scan the gateway's QR, and wait for the gateway status to become `linked`.

For API-driven linking, use a gateway key with write access to the agent:

```bash
curl -X POST http://localhost:10850/api/v1/agents/assistant/whatsapp/link \
  -H 'X-Api-Key: YOUR_WRITE_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"account_id":"default"}'

curl 'http://localhost:10850/api/v1/agents/assistant/whatsapp/status?account_id=default' \
  -H 'X-Api-Key: YOUR_WRITE_KEY'
```

Linking starts asynchronously; poll status to get the QR image and final state. Alternatively, POST `/api/v1/agents/assistant/whatsapp/pairing-code` with `account_id` and the account's `phoneNumber` in international format, then use WhatsApp's phone-number device-link flow to enter the resulting code.

The **device pairing code** links the account to the gateway. A **sender pairing code** in the next step approves someone who messages that account. They serve different purposes.

## Approve messages and test

From another WhatsApp account, send a private text message to the linked number. Compare the sender's code with the pending entry for this account, then add the sender to its `dmAllowlist`. Send a second message and verify a reply.

DM entries accept international numbers or user JIDs ending in `@s.whatsapp.net`; the access gate normalizes numbers. Group entries are full group JIDs ending in `@g.us`. Use IDs from the gateway's pending discovery. The linked number must already belong to a group before it can receive group messages. Approve the group, then mention the linked number when `requireMention` is true.

API discovery uses `GET /api/v1/agents/assistant/whatsapp/pending?account_id=default` with an admin key. To update policies through the agent PATCH API, include `whatsapp_account_id` plus `whatsapp_dm_allowlist`, `whatsapp_group_allowlist` or the other `whatsapp_*` policy fields. Include existing entries when replacing an allowlist. Link/status routes use `account_id`; policy PATCH uses `whatsapp_account_id`.

## Supported behavior

Text and inbound images are supported; inbound media downloads have a 20 MB cap. Read receipts default on after access approval. `reactionLevel: "ack"` adds a processing acknowledgement and clears it when a reply arrives; `off` suppresses both. Replies preserve the originating account so multiple numbers can have independent conversations and rules.

Gateway [orchestration](/guide/orchestration) applies to this channel's conversations too. The Telegram/Discord/LINE/Slack voice-note and native voice-control features are not implemented by this linked-device adapter; do not assume enabling agent voice adds WhatsApp audio ingestion.

## Troubleshooting and reconnecting

| Symptom | Check |
| --- | --- |
| `pending_scan` never becomes `linked` | QR is current, correct phone scans it, phone approves the device |
| `reconnecting` | Outbound connectivity and whether WhatsApp still lists the linked device |
| Works until gateway restart | Account state directory is persisted and readable |
| Linked but silent | Correct account's DM/group policies, pending approval and group mention |
| Policy change affects another number | Explicit `whatsapp_account_id` on PATCH and `account_id` on link/status calls |
| Missing old messages | Test with a new message after linking; linking is not a request to import chat history |

`POST .../whatsapp/unlink` logs out and wipes that account's session; a new link is required afterward. `DELETE .../whatsapp/accounts/:accountId` also removes the slot. See [account/link endpoints](/api/whatsapp) before automating account removal.

Implementation references: [WhatsApp manager](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/whatsapp/manager.ts), [account normalization](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/config/whatsapp-accounts.ts), and [access gate](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/api/whatsapp-access.ts).
