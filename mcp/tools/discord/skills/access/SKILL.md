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
/gateway:discord-access dm-policy <open|allowlist|disabled>
```

### Add/remove user from DM allowlist
```
/gateway:discord-access dm-allow <user_id>
/gateway:discord-access dm-deny <user_id>
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
  "dmPolicy": "disabled",
  "dmAllowlist": [],
  "guildAllowlist": [],
  "channelAllowlist": [],
  "roleAllowlist": []
}
```

## Implementation

Read `$DISCORD_STATE_DIR/access.json`, apply the requested change, write it back.
If the file does not exist, create it with defaults (dmPolicy: disabled, empty lists).

Always confirm the change made and show the new config.
