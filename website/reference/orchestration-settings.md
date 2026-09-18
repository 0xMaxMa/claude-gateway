# Orchestration settings

The gateway-level switch is `gateway.orchestration`, enabled by default. New installations use `true`; when an older configuration omits the switch, loading it saves `true`. An explicit `false` remains an opt-out. Migration preview and results include `gateway.orchestration` when the field is added. It applies to every agent and connected channel. The fields below live under **`agents[].orchestration`**, except voice, which lives directly under **`agents[].voice`**. Do not configure a second `enabled` or channel allowlist inside an agent's orchestration block.

Enabling orchestration saves `gateway.headless: true`. Both the conversation agent and workers run through Claude Code's headless execution path. Host process supervision requires Linux. App-agents run inside their own validated containers; a missing or unsafe container never falls back to host execution.

## Example

This is an agent-entry fragment. Keep the agent's existing workspace, Claude model, channels and credentials.

```json
{
  "id": "assistant",
  "orchestration": {
    "conversation": { "semanticIntake": true, "intakeWaitMs": 2000 },
    "tasks": {
      "workspaceMode": "host",
      "maxConcurrentPerAgent": 10,
      "maxConcurrentPerConversation": 10,
      "workerIdleTtlMs": 600000,
      "idleTimeoutMs": 300000,
      "questionReminderMs": 600000,
      "maxDurationMs": 0
    }
  },
  "voice": { "enabled": false }
}
```

## Conversation processing

| Field under `conversation` | Runtime default | Meaning |
| --- | --- | --- |
| `backend` | `inherit` | Use the configured Claude Code backend/model; no alternative backend name is supported |
| `semanticIntake` | `false` | Prepare incomplete materials and combine them with the next instruction |
| `intakeWaitMs` | `2000` | Wait after the latest incomplete input before asking for clarification; not an extra delay for complete instructions |
| `maxActiveSessions` | `2` | Bound concurrently active conversation decisions per agent |
| `notificationPolicy` | `existing_receive_path` | Deliver task events through the existing receive path; `next_user_turn` is also accepted |
| `idleTimeoutMs` | `120000` | Conversation decision inactivity budget; progress renews the idle clock |
| `startupTimeoutMs` | `120000` | Startup budget |
| `firstResponseTimeoutMs` | `120000` | Budget for first response activity |
| `compactionTimeoutMs` | `300000` | Per-compaction deadline for agents and workers; independent of first-response and idle budgets. Any configured total deadline still applies. |
| `maxDecisionDurationMs` | `600000` | Total decision budget; separate from worker task runtime |
| `preemptionGraceMs` | `250` | Accepted configuration field; currently not consumed by runtime preemption |
| `maxPendingInputs` | `100` | Bound queued conversation input |

`decisionTimeoutMs` is a compatibility alias for `idleTimeoutMs`. Its original template value `15000` is normalized to the modern default. Set `idleTimeoutMs` explicitly for new configurations.

`intakeWaitMs` measures received material, not microphone silence or an upload in progress. Voice turn detection has its own `turns.silenceCommitMs`. See [intake behavior](../guide/orchestration.md#conversation-intake).

## Worker pool and queue

| Field under `tasks` | Runtime default | Meaning |
| --- | --- | --- |
| `maxConcurrentPerAgent` | `10` | Worker concurrency budget across an agent |
| `maxConcurrentPerConversation` | `10` | Worker concurrency budget in one conversation |
| `workerIdleTtlMs` | `600000` | Retain an idle worker session for ten minutes for reuse |
| `maxQueuedPerConversation` | `20` | Pending queue bound in one conversation |
| `maxQueuedPerAgent` | `100` | Pending queue bound across the agent |
| `idleTimeoutMs` | `300000` | Quiet-worker observation budget; not an unconditional five-minute kill |
| `maxDurationMs` | `0` | Optional hard task deadline; zero disables total-duration expiry |
| `questionReminderMs` | `600000` | Minimum cooldown for agent-chosen question reminders: 1×, then 3×, then 6×; also requires three new user messages, not a fixed send schedule |
| `interruptAckTimeoutMs` | `5000` | Accepted configuration field; currently not consumed by the interruption path |
| `workspaceMode` | `host` | Host agents' workspace policy; installed app-agents use `container` |
| `projectRoot` | empty | Optional starting directory; empty uses the agent workspace |
| `resourceRetentionDays` | `7` | Retention policy for task resources; distinct from conversation history retention |

`defaultTimeoutMs` is the compatibility alias for the worker inactivity budget. If explicitly set and `idleTimeoutMs` is absent, it supplies that budget; it is not a fixed wall-clock task limit. Task queue limits and worker concurrency are different controls: a queued task does not mean another worker is already running it.

A new question wakes the Agent to prepare a natural separate message. Later reminders are considered on user turns only, after enough new messages and the configured cooldown. Discussion postpones reminders; natural-language requests can defer them for an hour or mute the current question. State survives restart. These controls do not approve decisions or change worker permissions. See [answering task questions](../guide/orchestration.md#answer-a-task-question).

### Workspace modes

| Mode | When to use it | Preconditions and boundary |
| --- | --- | --- |
| `host` | General host work, research, files, services, browser/API work or code | Uses the gateway operating-system account; no Git project is required |
| `isolated-worktree` | Work that deliberately needs a separate Git working tree | Requires an actual Git repository at the configured root or workspace; admission can return `WORKER_GIT_PROJECT_REQUIRED` |
| `shared-lock` | Explicitly serialized work in a shared workspace | Retains the configured policy; review task dependencies and concurrent work |
| `container` | Installed app-agents | Agent and worker stay within the app's validated Docker boundary; no host fallback or host Docker socket |

A host worker is not a sandbox protecting the rest of the account's files. A Git worktree is a workspace arrangement, not a security boundary. Container isolation, mounts and injected tools determine app access.

## Event retention and subscribers

| Field under `events` | Runtime default | Meaning |
| --- | --- | --- |
| `retentionDays` | `7` | Retain orchestration events for this period |
| `maxSubscriberBufferBytes` | `1048576` | Bound each subscriber's buffered event data |

Clients should resume streams using the API's documented cursors and refresh their snapshot when retention prevents replay. Task results and historical event delivery are different records; do not infer result deletion from an expired event cursor.

Unknown keys and invalid bounds fail validation rather than silently pretending to apply. Use [tasks API](../api/tasks.md), [orchestration API](../api/orchestration.md), and [voice](../guide/voice.md) for protocol-level integration.

Source: [configuration types, defaults and validation](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/orchestration/config.ts).
