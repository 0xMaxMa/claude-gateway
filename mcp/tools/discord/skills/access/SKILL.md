---
name: discord-access
description: Manage Discord channel access — guild/channel allowlists, DM policy, user/role allowlists.
user-invocable: true
---

# /gateway:discord-access — Manage Discord access

Use this skill to view or update Discord access settings stored at `$DISCORD_STATE_DIR/access.json`.

## Commands

### Show current access config
```
/gateway:discord-access show
```

### Set DM policy
```
/gateway:discord-access dm-policy <pairing|allowlist|disabled>
```

### Add/remove user from DM allowlist
```
/gateway:discord-access dm-allow <user_id>
/gateway:discord-access dm-deny <user_id>
```

### Approve a pending pairing code
```
/gateway:discord-access pair <code>
```

### Deny/remove a pending pairing code
```
/gateway:discord-access deny <code>
```

### Add/remove guild from allowlist
```
/gateway:discord-access guild-allow <guild_id>
/gateway:discord-access guild-deny <guild_id>
```

### Add/remove channel from allowlist
```
/gateway:discord-access channel-allow <channel_id>
/gateway:discord-access channel-deny <channel_id>
```

## Access file format (`access.json`)

```json
{
  "dmPolicy": "pairing",
  "allowFrom": [],
  "guildAllowlist": [],
  "channelAllowlist": [],
  "roleAllowlist": [],
  "pending": {}
}
```

## Implementation

Read `$DISCORD_STATE_DIR/access.json`, apply the requested change, write it back.
If the file does not exist, create it with defaults (dmPolicy: pairing, empty lists, empty pending).

### `pair <code>` implementation
1. Load `$DISCORD_STATE_DIR/access.json`
2. Look up `pending[code]` — error if not found
3. Check `pending[code].expiresAt > Date.now()` — error if expired
4. Add `pending[code].senderId` to `allowFrom` (deduped)
5. Delete `pending[code]`
6. Write `$DISCORD_STATE_DIR/approved/<senderId>` with the `channelId` as file contents
7. Save `access.json`
8. Report: "Paired! User `<senderId>` added to allowFrom. Bot will send confirmation within 5s."

### `deny <code>` implementation
1. Load `$DISCORD_STATE_DIR/access.json`
2. Look up `pending[code]` — error if not found
3. Delete `pending[code]`
4. Save `access.json`
5. Report: "Code `<code>` rejected and removed."

Always confirm the change made and show the new config.
