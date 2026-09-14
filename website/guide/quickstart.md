# Get your first reply

You will start the gateway locally, create an agent, and verify its connection before adding more channels.

## 1. Check the prerequisites

Use Node.js 22 or newer, an installed and authenticated Claude Code CLI with channels support (the repository requires 2.1.0 or newer), and Bun for the MCP subprocess.

```bash
node --version
claude --version
bun --version
```

Run Claude Code directly once to confirm authentication under the same operating-system account that will run the gateway. If the executable is outside that account's PATH, set `CLAUDE_BIN` to its absolute path.

## 2. Install and start

```bash
npm install -g @0xmaxma/claude-gateway
claude-gateway gateway start
```

The gateway runs in the foreground. Keep this terminal open and use another terminal for the following commands. Installation uses Bun to install MCP dependencies. Platforms without a compatible prebuilt `node-pty` binary may need native build tools.

On first start, the gateway creates `~/.claude-gateway/config.json` with an empty agent list and a random admin key. The gateway stores the key in that file with mode `0600` and prints only its suffix; the local CLI reads it automatically. An existing configuration is retained.

```bash
claude-gateway gateway status
curl --fail http://127.0.0.1:10850/health
```

The health endpoint should return `{"status":"ok"}`. It confirms liveness, not that an agent or its provider works. The port defaults to `10850`; adjust the URL if you set `PORT`.

## 3. Create an agent

```bash
claude-gateway agents create
claude-gateway agents list
```

Describe the agent in the interactive wizard, review the generated workspace files, and accept them. You can connect Telegram or Discord during creation. The agent hot-reloads without restarting the gateway.

## 4. Pair and send a message

For Telegram, send a private message to the bot to obtain a pairing code. Replace `assistant` with the agent ID you created:

```bash
claude-gateway channels pending --agent assistant --channel telegram
claude-gateway channels approve --agent assistant --channel telegram --code YOUR_CODE
```

Send “Hello, introduce yourself.” A reply confirms inbound delivery, access approval, model execution, and outbound delivery. If it stays silent, work through [channel checks](./channels.md) and [troubleshooting](./troubleshooting.md).

Next, [enable orchestration](./orchestration.md), optionally [configure voice](./voice.md), then [run it as a service](./operations.md) or [customize the agent](./agents.md).

Source: [first-run implementation](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/config/bootstrap.ts).
