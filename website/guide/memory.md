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

Source: [workspace memory composition](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/agent/workspace-loader.ts).

## Write durable context and episodic notes separately

Put standing preferences, recurring rules, and durable lessons in `MEMORY.md` or `USER.md`. Put dated work records in `memory/<topic>.md`, for example `memory/release-notes.md`. The archive indexes `MEMORY.md`, `USER.md`, and Markdown files recursively under `memory/`; an arbitrary project file outside those locations is not automatically a memory source.

With `gateway.memory.writeRouting: true`, generated instructions explicitly teach the agent this two-tier write contract. Its built-in default is `false`. The routing instruction guides the agent; it does not itself move existing content.

The per-agent search database is `<workspace>/../kb.sqlite`, next to `history.db`. Markdown remains the source material. Reindexing skips unchanged files by content hash, replaces chunks for changed files, and removes chunks whose source files disappeared. Default chunking uses 400 tokens with 80-token overlap and the SQLite FTS5 `unicode61` tokenizer.

Source: [archive indexer](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/agent/knowledge/indexer.ts) and [archive configuration](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/agent/knowledge/config.ts).

## Understand a memory budget warning

The 8,000-character memory and 3,000-character user budgets are soft composition budgets. `overBudget: "error"` increases the severity of the generated warning; it does not reject a file write. A zero budget disables that soft check. The loader's separate hard context limits still apply.

An over-budget `MEMORY.md` can appear in context as a compact section index, with short section briefs and instructions to retrieve the full text. Building that index is deterministic and does not rewrite the on-disk memory. If there are no suitable headings, the loader retains full-content handling instead.

Before consolidating, read the complete source or retrieve its sections. Rewriting the file from only the injected index would lose entries the model cannot currently see. After consolidation, check the source, the next spawned session's budget banner, and a retrieval of a detail retained in the archive.

## Retrieve personal or shared knowledge

Ask for `memory_search` with `corpus: "memory"` for this agent's archive, `"shared"` for shared knowledge, or `"all"` for both. Search results contain ranked snippets, source locations, and provenance. Use `memory_get` for the exact source excerpt before relying on a detail.

Shared knowledge is enabled by default with project `global`, root `~/.claude-gateway/shared/kb`, mode `auto`, and graph views disabled. A project's vault is `<root>/<project>/`, with Markdown under `notes/` and its own `kb.sqlite`. Agents assigned the same project share that vault; use deliberate project names when organizing teams or topics.

Shared promotion and personal memory consolidation have separate mode settings. Set `gateway.knowledge.shared.mode: "propose"` when you want shared promotion proposals instead of automatic shared writes. Changing dreaming mode alone is not a substitute for checking the shared configuration.

Source: [shared configuration and paths](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/agent/knowledge/config.ts) and [shared promotion](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/agent/knowledge/shared-promote.ts).

## Dreaming schedule, safeguards, and audit

Dreaming is enabled in `auto` mode by default. Its built-in start time is 03:00, with up to a 30-minute staggering window across agents, a 30-minute quiet window, a three-day lookback, and at most three proposed changes per run. The review model defaults to `claude-haiku-4-5-20251001`. An agent active inside the quiet window can have its cycle skipped rather than consolidated immediately.

Agent dreaming settings override gateway dreaming settings. The timezone falls through agent `dreamTimezone`, gateway `dreamTimezone`, `gateway.timezone`, then UTC. Use `mode: "propose"` for an audit-only consolidation review, and inspect `<workspace>/.dreaming/DREAMS.md` before enabling automatic changes.

Automatic application keeps pre-images under `.dreaming/backups/`, checks that source content has not changed concurrently, and bounds what proposals can modify. Review applied and skipped counts, not just the presence of a diary entry: a run can propose changes that the safe applier declines. Backups are created for changes that will actually be committed, so a no-op need not produce a new backup.

Staleness handling defaults to a 90-day TTL, retaining important or sufficiently retrieved entries according to its policy and limiting invalidations to 50 per run. Personal notes under `memory/pinned/` are searchable but exempt from archive aging. Shared knowledge also has staleness settings; weekly shared reflection is enabled by default for Sunday at 04:00, processing up to five clusters per run.

Source: [dreaming defaults](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/agent/dreaming/config.ts), [cycle implementation](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/agent/dreaming/index.ts), [safe applier](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/agent/dreaming/applier.ts), and [archive lifecycle](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/agent/knowledge/lifecycle.ts).

## Compact large resumed conversations at night

[Opt-in nightly session compaction](../reference/memory-settings.md#nightly-session-compaction) invokes Claude Code’s native `/compact` on quiet, oversized sessions. This is separate from consolidating memory files and preserves stored chat history. The **Nightly dreaming** dashboard combines both activities with filters, paginated run summaries and detailed outcomes.
