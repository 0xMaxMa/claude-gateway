# Agents and sessions

An **agent** owns a workspace, identity, model configuration, and channel connections. A **session** is one conversation's model context. Multiple agents can share one gateway while keeping their sessions separate.

## Define an agent

Create an agent with `claude-gateway agents create`, then edit its source workspace files:

| File | Purpose |
| --- | --- |
| `AGENTS.md` | Required core instructions and capabilities |
| `IDENTITY.md` | Name, emoji, avatar, identity |
| `SOUL.md` | Tone and speaking style |
| `USER.md` | User preferences |
| `MEMORY.md` | Long-term core memory |
| `HEARTBEAT.md` | Proactive schedules |
| `skills/` | Agent-specific reusable skills |

For example, an `AGENTS.md` can begin:

```markdown
You are a personal research assistant.
Explain your findings clearly and link to the sources you used.
Before changing a file, read its existing content.
Report what you verified and what remains uncertain.
```

The gateway assembles workspace files into `CLAUDE.md` on startup and file changes. Edit the source files, then ask the agent to describe its role to verify the update. Avoid editing the generated `CLAUDE.md`.

## Manage a conversation

In a paired Telegram private chat, `/session` shows the current session, `/sessions` switches between sessions, and `/new <name>` starts a new one. `/compact` summarizes context. `/stop` interrupts the current turn. `/restart` restarts a session after confirmation.

Changing the agent's model affects all its sessions. Use `/models` and confirm the choice in a private chat. Chat history and the model's active context are separate: compacting context does not mean the persistent history database has been erased.

## Tune capacity

`agents[].session.idleTimeoutMinutes` controls idle session eviction; `maxConcurrent` controls legacy concurrent sessions (the template uses 30 minutes and 20 sessions). These are different from worker task limits in [unreleased orchestration](../preview/orchestration.md).

Source: [workspace files and session pool](https://github.com/0xMaxMa/claude-gateway/blob/main/README.md#workspace-files).
