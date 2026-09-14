---
layout: home
hero:
  name: Claude Gateway
  text: Talk naturally. Run tasks. Stay connected.
  tagline: A self-hosted platform for Claude Code agents, bringing task orchestration, voice, and multi-channel conversations together.
  actions:
    - theme: brand
      text: Start your gateway
      link: /guide/quickstart
    - theme: alt
      text: Explore the API
      link: /api/
features:
  - title: Orchestrate work
    details: Keep the conversation responsive while Claude Code workers run tasks, report progress, and handle follow-up instructions.
    link: /guide/orchestration
  - title: Talk naturally
    details: Add speech recognition and spoken replies with per-agent voices, connected providers, and reusable audio playback.
    link: /guide/voice
  - title: Connect your channels
    details: Reach agents through Telegram, Discord, LINE, Slack, WhatsApp, WeChat, and your own API clients.
    link: /guide/channels
  - title: Knowledge that stays with you
    details: Combine focused core memory with a searchable archive, reusable skills, and scheduled consolidation.
    link: /guide/memory
  - title: Workflows you can operate
    details: Schedule recurring jobs, host apps, inspect logs, and integrate through a local CLI or authenticated API.
    link: /guide/operations
  - title: Claude Code runtime
    details: Run agents and workers through Claude Code, with explicit tool profiles, host workspace policies, and isolated app containers.
    link: /reference/architecture
---

## How the gateway works

Claude Code runs the conversation agent and its workers. Claude Gateway coordinates their work, routes messages and tool activity across channels, manages speech, and preserves task results and knowledge. Host workers can handle research, browser actions, files, services, or code; installed app-agents retain their container boundary.

## Choose your next step

| You want to… | Start with |
| --- | --- |
| Get your first reply | [Quickstart](./guide/quickstart.md) |
| Connect an existing bot | [Channels and pairing](./guide/channels.md) |
| Define an agent's behavior | [Agents and sessions](./guide/agents.md) |
| Build an integration | [CLI and HTTP API](./reference/cli-api.md) |
| Diagnose a running gateway | [Troubleshooting](./guide/troubleshooting.md) |
| Run tasks while staying in conversation | [Orchestration](./guide/orchestration.md) |
| Add speech input and output | [Voice](./guide/voice.md) |

This documentation covers the Agent Orchestration Engine, per-agent voice, and the gateway features alongside it. Check your installed version with `claude-gateway version`.
