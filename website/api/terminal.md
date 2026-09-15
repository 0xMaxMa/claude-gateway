# Terminal viewer (`/cli`) {#terminal-viewer-cli}

The `/cli` chat command opens a live, **agent-scoped** webview terminal for an agent
running with `gateway.headless: false`. Unlike `/dashboard` (admin, host-wide), a `/cli`
session can only ever reach the single agent that the pairing was created for — it never
issues or accepts the admin `dash_session` cookie. Requires `gateway.publicUrl` to be set
(the absolute, externally-reachable origin used to build the link); when unset, `/cli`
replies that the viewer is not configured.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/cli/:pairingId` | Pairing (binds the browser) | Device page — "waiting for approval" (Discord/LINE) or Telegram Mini App initData submit |
| `GET` | `/cli/:pairingId/status` | `cli_pair` cookie | Poll; issues the agent-scoped `cli_session` cookie once approved |
| `POST` | `/cli/:pairingId/tg-init` | Telegram initData | Verify the signed initData (HMAC with the agent's bot token) and unlock |
| `GET` | `/cli/:pairingId/view` | `cli_session` cookie | The xterm.js viewer, scoped to the pairing's agent (read-only by default) |
| `GET` | `/cli/:pairingId/sessions` | `cli_session` cookie | The agent's live `pty-shell` sessions to attach to |
| `POST` | `/cli/:pairingId/pty-ticket` | `cli_session` cookie | One-time PTY ticket, validated to belong to the pairing's agent |

**Authorization model.** The link is not a credential. Unlocking requires proof bound to
an allowlist-gated chat action: **Telegram** submits a signed Mini App `initData` (verified
against the agent's bot token; the `initData` user must match the pairing's user), while
**Discord** and **LINE** require the operator to tap **Approve** in the chat. The first
browser to open a link owns it (a link opened in a second browser is rejected), and the
`cli_pair` / `cli_session` cookies are `HttpOnly` and scoped to the pairing's path only.
