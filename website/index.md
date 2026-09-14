---
layout: home
hero:
  name: Claude Gateway
  text: A home for your agents.
  tagline: Connect Claude Code to your conversations, persistent knowledge, and everyday workflows. Self-hosted and built around your workspace.
  actions:
    - theme: brand
      text: Start your gateway
      link: /guide/quickstart
    - theme: alt
      text: Explore the API
      link: /reference/cli-api
features:
  - title: One gateway, many conversations
    details: Give each agent its own identity and workspace. Connect chat channels and keep sessions across restarts.
    link: /guide/channels
  - title: Knowledge that stays with you
    details: Combine focused core memory with a searchable archive, reusable skills, and scheduled consolidation.
    link: /guide/memory
  - title: Workflows you can operate
    details: Schedule recurring jobs, host apps, inspect logs, and integrate through a local CLI or authenticated API.
    link: /guide/operations
---

## Choose your next step

| You want to… | Start with |
| --- | --- |
| Get your first reply | [Quickstart](./guide/quickstart.md) |
| Connect an existing bot | [Channels and pairing](./guide/channels.md) |
| Define an agent's behavior | [Agents and sessions](./guide/agents.md) |
| Build an integration | [CLI and HTTP API](./reference/cli-api.md) |
| Diagnose a running gateway | [Troubleshooting](./guide/troubleshooting.md) |
| Evaluate delegated tasks or voice | [Unreleased orchestration preview](./preview/orchestration.md) |

::: info Version scope
The guide describes repository `main` at `650dc67` (package version **1.8.14**). The separately marked preview pages describe **unreleased PR #465**, not features shipped on main. Check your installed version with `claude-gateway version`.
:::
