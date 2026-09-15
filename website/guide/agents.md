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

`agents[].session.idleTimeoutMinutes` controls idle session eviction; `maxConcurrent` controls legacy concurrent sessions (the template uses 30 minutes and 20 sessions). These are different from worker task limits in [orchestration](./orchestration.md).

Source: [workspace composition](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/agent/workspace-loader.ts) and [session persistence](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/session/store.ts).

## What belongs to an agent and what belongs to a session

An agent's workspace is the durable source of its instructions and memory. A session holds the conversation context needed to continue one thread. Starting another session gives the model a fresh conversation while retaining access to the same agent workspace, skills, and searchable memory.

| Change | Scope | What to verify |
| --- | --- | --- |
| Edit `SOUL.md` or `USER.md` | Agent workspace | Generated instructions and a newly spawned session |
| Create or switch a session | One conversation | Session identifier and selected agent |
| Change the agent model | Agent configuration | Model shown for subsequent session work |
| Compact context | Active model context | Continued conversation and persistent history |
| Change shared knowledge | Agents using the same shared project | Retrieval source and project configuration |

Use separate workspaces for agents with different roles. The startup isolation guard rejects reused workspace paths and Telegram bot tokens; it also checks explicitly configured session directories. This prevents accidental context/configuration overlap. Host agents still execute with the gateway user's operating-system access, so a separate workspace is not a filesystem sandbox. Container-backed App Store agents have additional runtime boundaries described in [Apps](./apps.md).

Source: [context isolation guard](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/agent/context-isolation.ts).

## Workspace updates and context size

Workspace composition puts role, identity, style, user preferences, memory, and the skill menu into the generated instructions. Keep these files focused: the loader has a hard per-file limit of 20,000 characters and a total limit of 150,000 characters. Memory has smaller soft budgets and can be represented by a section index; see [Memory and knowledge](./memory.md).

Do not assume an already running model process has reread the files merely because the generated file changed. Instructions are composed for session spawning, and reload/restart handling can defer changes while work is active. Verify an instruction update with a newly spawned session. For a memory lookup, explicitly ask the agent to read the relevant file or use memory retrieval.

A useful workspace maintenance flow is:

1. Read the source file and edit the smallest relevant section.
2. Check the generated `CLAUDE.md` for the intended text and any truncation or budget banner.
3. Start a new session and ask a question that depends on the change.
4. Confirm both the answer and the selected agent, especially when several bots have similar names.

Source: [workspace loader](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/agent/workspace-loader.ts) and [agent runner reload handling](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/agent/runner.ts).

## Claude Code as conversational agent and task worker

The gateway runs Claude Code in two operating roles when `gateway.orchestration` is enabled. The user-facing agent retains the workspace identity and conversation, interprets requests, records execution tasks, answers status questions, and summarizes results. A worker runs Claude Code for an assigned task with its own execution profile, session identity, working directory, and permitted tool inventory.

The conversational role receives scoped task and memory tools. File edits, browser/connector operations, research, and other execution belong to workers. The agent can inspect an attached image directly when answering a visual question; editing or generating media becomes execution work. Workers report through task tools and stage files for delivery instead of sending directly to channels or spawning additional workers.

For ordinary users, this remains one assistant doing their work. For operators, the separation makes acceptance, queuing, running, failure, and completion independently inspectable. An acknowledgement is not completion; use the persisted task state and verification evidence. Follow-up constraints can update an existing task, while dependent steps use continuations. See [Orchestration](./orchestration.md) for task controls and delivery.

The enable switch is gateway-wide and applies to all supported channels. Per-agent orchestration settings tune conversation/task limits but do not provide independent enable/channel switches. Voice is configured on the agent separately; see [Voice](./voice.md).

Source: [runtime roles](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/session/runtime-profile.ts) and [gateway mode resolution](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/orchestration/gateway-config.ts).

## Worker workspaces and capacity

The default worker mode is `host`, starting in the agent workspace unless `tasks.projectRoot` specifies another absolute path. A Git repository is not required for host tasks. Host execution can use other user-authorized paths, so the task's working directory is not an operating-system access boundary.

| Mode | Workspace behavior | Use case |
| --- | --- | --- |
| `host` | Existing host directory | General authorized work with native Claude tools |
| `isolated-worktree` | Detached Git worktree created for the task | Independent repository edits with a recorded base commit |
| `shared-lock` | Shared project with serialized access and snapshots | Work that must use one project directory |
| `container` | App agent's validated container workspace | App-contained execution |

A shared-lock project must differ from, and not contain or sit inside, the agent identity workspace. App agents require container mode and never fall back to host execution. Resource failures can leave a worktree needing reconciliation so potentially useful edits are preserved.

Defaults allow ten concurrent tasks per agent and per conversation, with queue ceilings of 100 per agent and 20 per conversation. The worker idle timeout is five minutes; `maxDurationMs: 0` disables the optional total deadline. Idle workers can be retained for ten minutes for reuse. Gateway process limits default to 32 total processes with two slots reserved for conversational agent work. Queue limits, active process limits, and idle retention describe different resources; raising one does not raise the others.

A task's explicit model overrides the agent model for that worker. Runtime profiles require empty `claude.extraFlags`; configure the supported model field instead of bypassing profile construction with custom flags.

Source: [worker defaults](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/orchestration/config.ts), [workspace preparation](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/orchestration/tasks/workspace.ts), [worker driver](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/orchestration/tasks/driver.ts), and [process capacity](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/orchestration/capacity.ts).
