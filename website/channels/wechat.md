# WeChat

WeChat links one personal account per agent using Tencent's iLink Bot API bridge. Incoming messages arrive through long polling. The gateway integration supports DMs and text replies.

## Prerequisites and credential model

You need a personal WeChat account that can complete the iLink QR authorization flow and an existing gateway agent. Tencent's [openclaw-weixin project](https://github.com/Tencent/openclaw-weixin) is the upstream bridge reference; availability and account eligibility depend on that service.

There is no API-key field to copy from a developer console. QR authorization creates the session credentials. There is no text device-pairing option and no `/webhooks/wechat/...` route to publish. Outbound access from the gateway to the iLink service is required.

## Configure and link

Add the policy fragment to the existing agent entry if managing configuration manually:

```json
{
  "wechat": {
    "dmPolicy": "allowlist",
    "dmAllowlist": [],
    "pairing": true
  }
}
```

Optional `botAgent` is a short sanitized client identity string sent with iLink requests; it does not authenticate the account. Restart after manual edits.

Open the agent's WeChat connection settings, start linking, scan the displayed QR with the intended WeChat account, and confirm the authorization. Wait for status `linked`.

For API administration, start linking with a gateway key that has write access:

```bash
curl -X POST http://localhost:10850/api/v1/agents/assistant/wechat/link \
  -H 'X-Api-Key: YOUR_WRITE_KEY'
```

While that request is waiting, query from another terminal:

```bash
curl http://localhost:10850/api/v1/agents/assistant/wechat/status \
  -H 'X-Api-Key: YOUR_WRITE_KEY'
```

The status response supplies a QR data URI while `pending_scan`. Link waits until authorization completes or the approximately two-minute attempt window expires. Possible states are `unlinked`, `pending_scan`, `linked` and `reconnecting`. The gateway persists the linked session under `<workspace>/.wechat-state/`; retain that state across restarts.

## Approve a sender

Send a new private message from a contact. Under the default allowlist policy, the contact gets a pairing code. Compare it with the pending entry in the agent's WeChat settings, then add the exact iLink sender ID to `dmAllowlist`. Send another message and verify a reply.

Administrators can read `GET /api/v1/agents/assistant/wechat/pending`, then PATCH `wechat_dm_allowlist` on the agent. Include current approved IDs when replacing the list. Other policy API fields are `wechat_dm_policy` and `wechat_pairing`. A WeChat display name, phone number or QR image does not substitute for the sender ID supplied by iLink. The CLI `channels approve` command is only for Telegram/Discord.

Linking authorizes the account connection; approving a sender authorizes that person to reach the agent. These are separate checks.

## Behavior and limitations

This adapter has one account per agent and no group policy fields. It does not provide WeChat group support. iLink polls with a 35-second timeout; an idle long poll is normal. Outgoing text is split around the 4,000-character message cap, preferably on line boundaries.

Gateway [orchestration](/guide/orchestration) applies to WeChat conversations, but this adapter does not implement the voice-note ingestion or native voice controls available on Telegram, Discord, LINE and Slack. Use supported text messages for the first end-to-end test.

Setting `WECHAT_CHANNEL_DISABLED=true` in the gateway environment prevents linking and stops previous sessions from resuming on startup. To intentionally remove the account, POST `/api/v1/agents/assistant/wechat/unlink`; it wipes the linked session and requires a fresh QR authorization.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Link returns an error immediately | `WECHAT_CHANNEL_DISABLED`, service reachability and gateway logs |
| QR expires | Start a new attempt and finish the authorization promptly |
| QR scan cannot authorize | Account eligibility/current iLink availability; use Tencent's upstream guidance |
| `linked` but no answer | New DM delivered, exact sender ID approved, agent able to execute |
| Group messages absent | Groups are unsupported by this integration |
| Repeated relinking after restart | Persistent, writable `.wechat-state` directory |
| Slow response while idle | Distinguish normal long-poll wait from processing/network errors |

Implementation references: [WeChat manager](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/wechat/manager.ts), [iLink client](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/wechat/ilink-client.ts), and [access gate](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/api/wechat-access.ts).
