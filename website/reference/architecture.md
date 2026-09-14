# Architecture

Claude Gateway coordinates Claude Code rather than replacing it with a separate model runtime. The gateway owns channel ingress, access checks, conversation state, tasks, provider configuration, speech transport and delivery. Claude Code supplies the agent and worker execution environment.

## From a message to a result

1. A channel receiver or authenticated API accepts input. Channel identity and API principal checks decide which agent and conversation it can access.
2. The orchestration ingress persists the input. Repeated delivery IDs can be recognized instead of starting duplicate work.
3. The conversation agent reads the input and relevant current state. A complete work instruction receives a contextual acknowledgement; a direct question can receive a direct answer.
4. Substantial work is admitted as a task with a worker profile, revision, dependencies and workspace policy.
5. The scheduler starts or reuses a compatible Claude Code worker. Tool calls and progress update durable task activity.
6. Worker completion or a request for input returns to the conversation through events. The agent reports the result or asks the needed question.
7. Channel delivery formats text for that platform and, if enabled for the input, generates a spoken response. Browser clients also receive session activity and audio streams.

The conversation agent can explain progress while a worker runs. A worker does not need to finish before another user message is accepted. A successful HTTP admission response proves acceptance, not completion of a task or outbound message.

## Processes and ownership

| Component | Responsibility | Lifetime |
| --- | --- | --- |
| Gateway | Configuration, API, scheduling, access, delivery, state | Service/foreground process |
| Channel receiver | Platform connection and incoming updates | Owned by the gateway; implementation varies by channel |
| Conversation decision | Interpret current input/events and choose the next response/actions | Headless Claude Code turn with bounded decision budgets |
| Worker | Execute an admitted task with the allowed tools and workspace | Reusable session, bounded by pool policy and idle TTL |
| MCP server | Expose gateway tools according to the agent/worker profile | Tied to the Claude Code execution context |
| External connector | Third-party MCP endpoint selected and authorized by the operator | Managed separately; injected into authorized execution contexts |

`gateway.orchestration: false` selects the legacy conversation path. `gateway.headless: false` is the optional legacy PTY backend. Orchestration requires headless execution and Linux supervision; it is not a PTY session hidden behind the web UI.

## What persists

| State | Purpose |
| --- | --- |
| Agent workspace source Markdown | Identity, rules, preferences, core memory, skills |
| Generated Claude instructions | Composed view read by the subprocess; edit source files instead |
| Session context/history | Conversation continuity and searchable past messages |
| `orchestration.db` per agent | Inputs, decisions, tasks, revisions, events, worker state and deliveries |
| Memory archive / shared knowledge | Searchable longer-lived information outside the core prompt budget |
| Replay audio | Completed retained speech, subject to size/age budgets |
| App data and backups | Docker app state, separate from chat history |

A process restart and deletion of persistent state are different operations. Cancellation does not roll back external side effects or erase work files. After an interrupted run, reconcile actual files and external state before retrying.

## Tools and workspace boundaries

Worker profile admission checks the exposed tool inventory. Gateway and MCP code must be from a consistent deployment. A profile mismatch is an actionable configuration/deployment failure; it must not be bypassed by granting every tool.

Host workers use the gateway's OS account and authorized tools. Default host work requires no Git repository. `isolated-worktree` is explicit, and provides a separate Git working tree rather than an operating-system sandbox. Installed app-agents and their workers execute inside the app's validated container; they must not inherit host shell/MCP access, the host Docker socket, or a fallback host worker.

See [tools and connectors](../guide/tools.md), [worker settings](./orchestration-settings.md), and [app boundaries](../guide/apps.md).

## Voice is a separate delivery path

Speech recognition produces text input. The conversation agent produces display text and approved spoken text. Speech synthesis converts that spoken text into audio, which is delivered after or alongside the appropriate text protocol. The voice language follows the response language; a chosen voice does not translate the answer.

Provider behavior affects latency: realtime STT can emit partial words; recorded STT waits for the completed segment. Some TTS adapters stream audio while others buffer provider output. Browser replay uses a retained recording, not another model request. See [voice](../guide/voice.md) and its [protocol](../api/voice.md).

Implementation: [orchestration runtime](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/orchestration/runtime.ts), [agent runner](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/agent/runner.ts), [MCP server](https://github.com/0xMaxMa/claude-gateway/blob/b917843/mcp/server.ts), [voice session](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/voice/session.ts).
