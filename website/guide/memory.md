# Memory and knowledge

Use core memory for information an agent should see every turn, and the searchable archive for detail it can retrieve when needed.

| Layer | Use it for | How to inspect it |
| --- | --- | --- |
| `MEMORY.md` and `USER.md` | Durable facts and preferences | Read the workspace files |
| Per-agent archive | Longer notes outside the core budget | Ask for `memory_search` and `memory_get` |
| Shared knowledge | Knowledge made available across agents | Dashboard Knowledge base tab |
| Chat history | Past conversations | Session history and history search |

## Verify recall

Add a harmless project fact to a workspace note. Ask the agent to retrieve that specific fact and cite the source. Repeat in a new session to distinguish persistent recall from the current conversation's context. A plausible answer without a source is insufficient verification.

## Control the budget

The template sets `gateway.memory.memoryBudgetChars` to `8000` and `userBudgetChars` to `3000`, with `overBudget: "warn"`. Archive notes that do not belong in the core context instead of increasing the budget indefinitely.

`gateway.knowledge.archive` configures the SQLite/FTS5 searchable archive. `gateway.knowledge.shared` controls the shared knowledge location and mode. See the [configuration reference](../reference/configuration.md) before changing defaults.

## Review nightly dreaming

`gateway.dreaming` schedules background consolidation. The safe applier backs up memory and bounds changes; archived material can remain searchable after it leaves core memory. Inspect the dashboard's Nightly dreaming tab and the agent's `.dreaming/DREAMS.md` audit to understand a run.

Do not confuse history retention with memory consolidation. `gateway.history` and agent history overrides remove old chat/media records on their configured schedule; dreaming changes memory content.

Source: [memory, dreaming, and knowledge settings](https://github.com/0xMaxMa/claude-gateway/blob/main/README.md#gatewaymemory).
