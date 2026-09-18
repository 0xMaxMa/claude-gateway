# Memory, learning and knowledge settings

These settings are read from `config.json`. Examples are partial objects to merge into an existing configuration. Defaults in the tables refer to runtime fallback values; the installed template may explicitly choose a different value.

## `gateway.skillLearning`

Controls [skill learning](../guide/tools.md) — agents learning reusable skills from their own work. Telemetry capture is always on; the reviewer/writer/curator honor `enabled`.

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Master switch for the reviewer/writer/curator (telemetry is captured regardless) |
| `mode` | `"auto"` | `auto` writes skills directly; `propose` queues them for approval instead |
| `minToolCalls` | `5` | Minimum tool calls in a turn before it's eligible for review |
| `reviewModel` | `claude-haiku-4-5-…` | Model used for the background review pass |
| `maxAutoSkills` | `50` | Cap on the number of non-pinned `origin: auto` skills kept per agent (pinned skills are never evicted and don't count toward the cap) |
| `maxAgeDays` | `30` | Curator prunes auto-skills older than this (with too few uses) |
| `minUsesToKeep` | `2` | Auto-skills used fewer times than this are prune candidates |
| `maxReviewsPerDay` | `20` | Per-day cap on background review runs |
| `pruneHour` / `pruneTimezone` | `3` / `UTC` | When the daily curator runs; `pruneTimezone` falls back to `gateway.timezone` when unset or invalid |
| `notify` | `true` | Notify only the originating session (see [skill notifications](../guide/tools.md)); the `SKILLS_LEARNED.md` diary is written regardless |

```json
{
  "gateway": {
    "skillLearning": {
      "enabled": true,
      "mode": "auto",
      "notify": true
    }
  }
}
```

Per-agent overrides are supported under the agent's own `skillLearning` block; unset fields fall back to the gateway default.

## `gateway.memory`

Memory budget discipline. Self-authored memory files (`MEMORY.md`, `USER.md`) that exceed a **soft** char budget get a loud over-budget banner prepended to their `CLAUDE.md` section at compose time — instead of a silent `[TRUNCATED]` — nudging the agent to consolidate. The banner reaches the agent on its next spawn (frozen-at-spawn, no restart) and self-heals once the file is back under budget. The banner lives only in the composed `CLAUDE.md`; the source file on disk is never rewritten with it.

| Field | Default | Description |
|-------|---------|-------------|
| `memoryBudgetChars` | `8000` | Soft budget for `MEMORY.md` (`0` = disabled) |
| `userBudgetChars` | `3000` | Soft budget for `USER.md` (`0` = disabled) |
| `overBudget` | `"warn"` | Banner severity: `warn` (⚠️) or `error` (🛑, stronger wording); an unknown value falls back to `warn` |
| `writeRouting` | `false` (template: `true`) | Inject the **two-tier write contract** into the Memory Rule (`MEMORY.md` = durable facts; task-log → `memory/<topic>.md`) and let nightly dreaming route episodic ops out. `false` = kill-switch (exact pre-routing behavior) |
| `episodicArchiveDir` | `"memory"` | Workspace-relative dir episodic notes are written under (validated, path-traversal-guarded) |

```json
{
  "gateway": {
    "memory": {
      "memoryBudgetChars": 8000,
      "userBudgetChars": 3000,
      "overBudget": "warn",
      "writeRouting": true,
      "episodicArchiveDir": "memory"
    }
  }
}
```

The soft budget sits well under the hard per-file limit (still applied as a context safety net); the banner is the primary over-budget signal for memory files.

**Write routing (planning-65).** `MEMORY.md` is injected into every prompt, so it should hold only **durable semantic facts** (preferences, standing rules, identity, lessons). **Episodic task-log** (completed work, PR/issue status, dated events) belongs in `memory/<topic>.md` — indexed and retrieved on demand via `memory_search`, never carried in-prompt. When `writeRouting` is on, the Memory Rule states this tier contract to the agent, and the nightly dreaming reviewer may emit `tier:"episodic"` ops that the applier appends to `memory/<topic>.md` (slug-validated + realpath-confined; a memory-only change ⇒ no session restart). To drain an existing over-budget `MEMORY.md`, run the one-shot migration `node dist/agent/dreaming/migrate-cli.js <workspaceDir> [--apply]` — a deterministic terminal sweep (compactor) plus a gated episodic route-out (`propose` writes `.dreaming/migration-plan.md`; `--apply` performs the moves). Pinned sections (`## User`, `## Feedback`, `## Preferences`) are never moved, and every relocated entry stays searchable via `memory_search` (recall preserved). **planning-67:** with `gateway.dreaming.autoRouteOut` on (the default), the nightly dream performs this same route-out **automatically** whenever `MEMORY.md` is over budget — no manual per-agent run — and every over-budget net-shrink `remove` now **relocates** its block to `memory/archive/pruned.md` (searchable) before cutting it, so no dream op ever silently forgets.

## `gateway.dreaming`

Nightly memory **dreaming** — background consolidation of an agent's long-term memory. A print-only `claude -p` reviewer (no tools, no `--dangerously-skip-permissions`) reads a lookback window of the agent's own session transcripts and proposes memory-consolidation ops. In **`auto`** mode (the default) a safe applier writes the ops to `MEMORY.md`/`USER.md` (rollback pre-image first; ordered apply with anchor re-resolution; bounded-loss + append-only fallback; net-negative when over budget) — a memory-only change, so no session is restarted. In **`propose`** mode the proposals are written **only** to a `DREAMS.md` diary + JSONL audit under `<workspace>/.dreaming/` — no memory file is modified (set `mode: "propose"` to keep this dry-run behavior).

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Master switch (`false` ⇒ no scheduler, no run) |
| `mode` | `"auto"` | `auto` = apply ops via the safe applier (backup, bounded-loss, net-negative); `propose` = diary-only dry-run |
| `dreamHour` / `dreamTimezone` | `3` / `UTC` | When the nightly dream runs (invalid tz → `gateway.timezone`, then UTC); `dreamTimezone` falls back to `gateway.timezone` when unset or invalid |
| `dreamMinute` | `0` | Minute-of-hour the dream fires at, paired with `dreamHour` (0–59). Set with `staggerWindowMinutes: 0` to fire at an exact `HH:MM` (e.g. for a controlled re-test) |
| `quietMinutes` | `30` | Skip a run if a session was active within this window |
| `lookbackDays` | `3` | How far back to scan sessions |
| `maxChangesPerRun` | `3` | Cap on proposed ops per run (`0` ⇒ no-op) |
| `reviewModel` | `claude-haiku-4-5-…` | Cheap model for the reviewer |
| `promotionThreshold` / `minRecallCount` | `0.6` / `2` | Scoring thresholds for promoting a fact |
| `autoRouteOut` | `true` | planning-67: in `auto` mode, drain an **over-budget** `MEMORY.md` by routing its episodic task-log to `memory/<topic>.md` automatically each night (archive-safe, pinned excluded, idempotent) instead of a manual per-agent `migrate-cli`. `false` = kill-switch |
| `staggerWindowMinutes` | `30` | planning-68: spread agents' nightly runs across a window (a deterministic per-agent jitter is added to the delay) so they don't all fire at `dreamHour:00` together. Clamped `[0,55]`; `0` = disabled (all fire at `dreamHour:00`) |
| `staleness` | *(object)* | Archive staleness GC sub-config (planning-66) — see below |

Per-agent overrides are supported under the agent's own `dreaming` block; unset fields fall back to the gateway default. `enabled:false` or `maxChangesPerRun:0` makes a run a no-op.

> **⚠️ Upgrade note:** the default `mode` for both `gateway.dreaming` and `gateway.knowledge.shared` changed from `propose` (dry-run) to `auto` (configVersion 1.0.24). Once the K4 applier landed (backup + net-negative + bounded-loss + CAS + never-empty; memory-only write ⇒ no session restart), `auto` became the intended default: nightly dreaming now applies consolidation to `MEMORY.md`/`USER.md` and promotes durable memories to the shared vault. Like the `gateway.bind` migration, the migrator upgrades the *retired* `propose` default to `auto` once and logs a one-time warning; an explicit `mode` you set at 1.0.24+ is never touched. To keep dry-run, set `mode: "propose"` explicitly.

**Keeping `MEMORY.md` near budget (`auto` mode).** Two mechanisms stop the on-disk `MEMORY.md` from growing unbounded while preserving recall:

- **Deterministic compaction** — before the LLM reviewer, every `auto` run moves completed/terminal log entries out of `MEMORY.md` into `memory/archive/completed.md`, leaving a one-line pointer. It is **domain-agnostic** (not just dev): an entry is archived when its lead line carries an explicit done marker — an UPPERCASE status word (`DONE`, `COMPLETED`, `RESOLVED`, `CLOSED`, `CANCELLED`, `ARCHIVED`, `MERGED`, `SUPERSEDED`, `OBSOLETE`, `DEPRECATED`, `EXPIRED`, `SHIPPED`, `FINISHED`), a checked task box `[x]`, a ✅, or a ~~strikethrough~~ — and it works on both list bullets and `###` entry headers. The archive lives under `memory/` so it is still indexed and **searchable via `memory_search`** — the agent recalls completed work on demand instead of carrying its full changelog in-prompt. It is conservative (uppercase words only, so prose like "Closes #123", "we're not done", or an unchecked `[ ]` box is never archived), idempotent, and only moves entries whose lead line matches a terminal marker, preserving their original text in the archive.
- **Budget-scaled pruning** — when `MEMORY.md` is over its soft budget, the reviewer is put in an explicit net-shrink mode (propose only length-reducing ops) and `maxChangesPerRun` scales up **for removals** (the add cap stays tight), so an over-budget file converges toward budget instead of trickling at a few edits per night.
- **Archive staleness GC (`gateway.dreaming.staleness`, planning-66)** — a deterministic pass that runs next to the compactor (auto mode) to keep the Lane-2 archive's **search quality** high. This is a **search-quality fix, not a prompt-budget one**: planning-65 already moved task-log off the injected prompt, so the point here is that `memory_search` should keep surfacing *current* truth instead of stale/superseded facts. Each nightly run **soft-invalidates** archive entries — superseded ones (a deterministic `supersedes/replaces/obsoletes #N` match, which finally populates the previously-inert `supersedes_key`) and aged-out ones (idle-since-last-**retrieval** past `staleTtlDays` and retrieved fewer than `minRetrievalKeep` times) — by **moving** them to `memory/archive/stale.md` and stamping `invalid_at`. It **never deletes**: a staled entry stays under `memory/` so it is still indexed and **searchable** . An entry that is **retrieved after** it was invalidated is **promoted back** to the active archive (the recall feedback loop — proof we aged it out too soon). Recall is fed by an append-only read-path log (`kb_retrieval_log`, gated by `recordRetrievals`) that the GC folds into each entry's `last_retrieved`. High-importance entries (`keepImportance`) and **pinned** files (`memory/pinned/**`) are never aged out; evergreen Lane-1 (`MEMORY.md`/`USER.md`) is structurally excluded. Every move is CAS-guarded with a timestamped backup, and — being a memory-only write — drops **no live session**. One run may soft-invalidate at most `staleness.maxInvalidationsPerRun` entries (default `50`), oldest-idle first, with the remainder resuming on later runs — aging is wall-clock driven, so without a ceiling the first run after anything that widens the GC's visibility (such as backfilling lifecycle rows for previously invisible sources) would relocate every already-expired entry in one night. Restores are never capped. Kill-switches: `staleness.enabled:false` (GC no-ops), `maxInvalidationsPerRun:0` (never invalidates, still restores) and `recordRetrievals:false` (age falls back to first-seen only).

## `gateway.knowledge`

**Two-lane memory** — a per-agent searchable knowledge archive so an agent can recall what does not fit in the always-injected core. A SQLite/FTS5 index (`agents/<id>/kb.sqlite`, built on Node's built-in `node:sqlite` — no new dependency) covers the agent's `memory/*.md` notes plus the evergreen `MEMORY.md`/`USER.md`. Every chunk is tagged with **fail-closed provenance** (`owner`/`agent`/`untrusted`/`system`; unclassified ⇒ `untrusted`). The index is refreshed by a detached subprocess at session spawn, entirely **off the gateway event loop**.

Two read-only MCP tools expose it to the agent: **`memory_search`** (keyword/FTS5 → ranked snippets with file+line, provenance, importance) and **`memory_get`** (bounded, path-traversal-guarded excerpt of a memory-scoped file). When `MEMORY.md` grows past its `gateway.memory` soft budget, compose injects a compact **auto-generated section index** + a pointer to `memory_search` instead of the truncated full text (**core-shrink**) — the on-disk file is never modified and its full content stays searchable. Whenever the archive is on, a short `--- MEMORY RETRIEVAL ---` note is also injected into every agent's system prompt so the tools stay discoverable at all times (not only when the file is over budget).

| Field | Default | Description |
|-------|---------|-------------|
| `archive.enabled` | `true` | Master switch (`false` ⇒ complete no-op, no DB created, no core-shrink) |
| `archive.tokenizer` | `"unicode61"` | FTS5 tokenizer (`"trigram"` for CJK/Thai) |
| `archive.chunkTokens` | `400` | Target chunk size in ~tokens |
| `archive.chunkOverlap` | `80` | Overlap between chunks (clamped below `chunkTokens`) |
| `shared.enabled` | `true` | Enable the cross-agent shared KB |
| `shared.project` | `"global"` | Sharing partition key (one safe path segment) — agents with the same value share one vault; `"global"` ⇒ shared-by-default |
| `shared.root` | `~/.claude-gateway/shared/kb` | Shared vault root dir (`<root>/<project>/`) |
| `shared.mode` | `"auto"` | Per-agent→shared promotion mode; `auto` = promote durable dreamed facts, `propose` = dry-run |
| `shared.graph` | `false` | Compile the memory-wiki graph + dashboards over the shared vault to `<vault>/reports/*.md` (opt-in). Independent of the dashboard **Knowledge base** tab, which computes its graph on-demand |
| `shared.staleness` | *(object)* | Shared-note TTL lifecycle GC; uses the same fields/defaults as `dreaming.staleness` (whole notes only; no numeric `supersedes #N` syntax) |
| `reflection.enabled` | `true` | Enable the singleton, per-shared-vault reflection scheduler (daily timer; see cadence note below) |
| `reflection.dayOfWeek` / `hour` / `minute` / `timezone` | `0` / `4` / `0` / `UTC` | `hour`/`minute` is the **daily** staleness-GC slot; `dayOfWeek` selects the weekday that additionally runs LLM consolidation (Sunday 04:00 UTC by default; invalid timezone falls back to `gateway.timezone`, then `UTC`) |
| `reflection.maxClustersPerRun` / `reviewModel` | `5` / `claude-haiku-4-5-…` | Hard cap on changed linked-note clusters per consolidation run and the bounded synthesis model |

**Shared KB.** A shared SQLite/FTS5 vault outside any single agent's workspace lets agents build a common knowledge base. Notes under `<root>/<project>/notes/*.md` are indexed and reachable via `memory_search` with `corpus:"shared"` (the shared vault) or `corpus:"all"` (this agent's memory + shared, merged by relevance). Concurrent writers are safe without a lock — atomic note writes (temp+rename) plus a cross-process `PRAGMA busy_timeout` on the index. Per-agent overrides under the agent's own `knowledge` block. The MCP layer runs under Bun, so the read tools query `kb.sqlite` via `bun:sqlite`. Two write paths feed the vault, sharing one freeform-name namespace (issue #386, no agent-id prefix, no ownership scoping): the nightly dreaming promoter (gated by `mode:"auto"`; it promotes only content that carries a real fact — content that is nothing but `MEMORY.md` index-pointer bullets is skipped, since those links resolve only inside the promoting agent's own workspace — and names each note after the proposal's `topic` slug when the reviewer supplied one, falling back to its `reason`, so a recurring fact updates the same note across nights instead of piling up near-duplicates; a fallback name that reads as an editing instruction rather than the name of a fact is passed over, and the note is named from the fact itself instead — the promotion is only abandoned when nothing nameable remains, and every skip is logged — including a write the note-size cap refuses and an unexpected write failure. A name that doesn't collide is checked against a near-duplicate search, but an unattended **merge** now also requires real token containment against the candidate — below that bar the fact gets its own note, since two notes are recoverable while two unrelated facts fused into one are not. `[[wikilink]]`s to related notes use a lower bar than merges, because a link is additive where a merge is destructive — and they are attached whether the fact merges or lands as a new note, so a note below the merge bar is never a disconnected graph node. Containment is scored against each candidate's full body rather than the matched chunk, though against a capped seed — the bar means "half of the fact's leading topic words are already here", not half of the whole fact. Retired `stale__*` notes are never merge targets; a recurrence of a retired name folds the retired body back in and removes the twin on both the create and the update path, because a retired note stays searchable and a twin beside a live note of the same name would answer every query twice forever. The twin is only dropped once the merged write lands (issue #398)) and the **`memory_shared_create`**/**`memory_shared_get`**/**`memory_shared_update`**/**`memory_shared_delete`** MCP tools, which let any agent create, read, update, or delete any note on demand regardless of `mode`. `memory_shared_create` warns instead of writing when it finds content-similar existing notes (pass `confirm:true` to proceed — related notes get `[[wikilink]]`ed into the new note rather than left disconnected); `memory_shared_update` warns instead of writing when the edit would drop 50%+ of the existing note's lines (same `confirm:true` escape hatch). Immediate reindex after every write or delete.

**Shared lifecycle + reflection (issues #392, #398).** Each shared note receives a stable whole-file lifecycle identity during indexing — including notes whose content has not changed since they were first indexed, which are backfilled from their source mtime so their real age is preserved. Its deterministic TTL GC runs **daily**, soft-invalidating aged low-recall notes by moving them to `notes/stale__<name>.md` (never deleting them from the searchable vault); a retrieval after invalidation restores the original active name. Shared `memory_search` and `memory_shared_get` reads feed the same append-only retrieval log as personal archive recall. The singleton reflection scheduler runs **once per resolved shared-vault root**, not once per agent, and fires **daily** at `hour:minute` (a fire that lands a hair early re-arms on the *next* day's slot rather than serving the same one twice): every fire runs the inexpensive TTL GC (no model call), while graph/LLM consolidation runs only on `dayOfWeek` — and even then is skipped when `kb_index_state.revision` has not changed since the prior consolidation. Weekly model spend is therefore unchanged, while a note that is retired and then retrieved returns to the active set within a day instead of up to a week. For changed vaults it clusters only active wikilink-connected notes deterministically, then makes at most `reflection.maxClustersPerRun` bounded reviewer calls to merge genuinely duplicate clusters; related-but-distinct notes remain merely linked.

**Knowledge base viewer.** The web dashboard's **Knowledge base** tab renders the shared vault as an Obsidian-style force-directed graph (nodes = notes sized by link degree and coloured by `type`; edges = `[[wiki-links]]`; contradicting claims and stale notes are flagged). It is fed by `GET /knowledge/graph`, which computes the model **on-demand** from the vault (no dependency on `shared.graph` or the nightly reindex). When the vault is empty it shows a clearly-labelled demo dataset (with a size selector for scale testing). A **source** selector switches the graph between the cross-agent Shared KB and any single agent's own Lane-2 memory (`workspace/memory`), a node **search** box filters the graph, and clicking a node opens its full note (fetched via `GET /knowledge/note`) rendered as Markdown below the graph.

**Nightly dreaming viewer.** A **Nightly dreaming** tab renders each agent's memory-consolidation audit trail (`.dreaming/DREAMS.md` + `promotions.jsonl`) as a newest-first timeline of runs — mode (propose/auto), outcome, the proposed/applied changes with scores + anchors, and per-run token/session counts — fed by `GET /knowledge/dreams` and filterable by agent. For a `propose`-mode run you can **accept** proposals directly from the tab: an **Accept** button per proposal (and **Accept all** per run) POSTs to `POST /knowledge/dreams/apply`, which applies the selected ops to `MEMORY.md`/`USER.md` through the same K4 safe applier auto mode uses (backup + bounded-loss + net-negative + CAS; memory-only ⇒ no restart) and — when the shared KB is `auto` — promotes applied `add`s to the shared vault. Accepts are idempotent (recorded to `.dreaming/accepted.jsonl`); applied proposals show ✓ and a proposal whose anchor has since drifted is safely skipped and stays pending for a later retry.

Implementation: [config loader](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/config/loader.ts), [configuration template](https://github.com/0xMaxMa/claude-gateway/blob/b917843/config.template.json).

## Nightly session compaction

Memory dreaming consolidates workspace memory files. **Session compaction** separately reduces a resumed Claude Code conversation using its native `/compact` command. It does not delete stored chat history, rebuild the conversation from recent messages, or ask a question when a user returns.

Enable it explicitly in `gateway.sessionCompaction`; individual `agents[].sessionCompaction` fields override the gateway values:

```json
{
  "gateway": {
    "sessionCompaction": {
      "enabled": true,
      "thresholdPercent": 50,
      "quietMinutes": 60,
      "maxSessionsPerRun": 5
    },
    "dreaming": {
      "dreamHour": 3,
      "dreamMinute": 0,
      "dreamTimezone": "Asia/Bangkok",
      "staggerWindowMinutes": 30
    }
  }
}
```

The compaction defaults are `enabled: false`, `thresholdPercent: 50`, `quietMinutes: 60`, and `maxSessionsPerRun: 5`. The threshold is clamped to 1–99%, quiet time to 1–10,080 minutes, and the run limit to 1–100 sessions. The schedule inherits the agent's effective dreaming hour, minute, timezone and deterministic staggering. Memory dreaming may be disabled while session compaction remains enabled. Orchestration must be enabled. Restart the gateway after editing these configuration fields to apply the schedule consistently.

Each nightly sweep examines up to 1,000 recently mapped native sessions. A session qualifies only when its latest measured context exceeds the configured percentage of the selected model's known context window. Sessions with active tasks, a running agent, pending input, recent conversation activity, missing measurements, an unknown model window or an unavailable native transcript are skipped. Eligibility is checked again immediately before compaction; normal incoming messages retain their usual admission path.

Only one nightly compaction runs at a time across the gateway. Sessions sharing a native transcript share activity checks and compaction fences. The per-agent limit bounds native compaction attempts, and a shutdown stops new attempts. A successful compaction is not repeated against the same old measurement; another conversation turn must first produce fresh usage. A previously recorded manual compaction or `/clear` also prevents using the old measurement for a nightly attempt. Context changes during model lookup are checked again before maintenance. Runs interrupted by process termination remain visible in the audit report.

Open **Nightly dreaming** in the admin dashboard to see both memory dreaming and session compaction, newest first, with date, agent, kind and status filters. Select a run to see proposals or per-session outcomes, skip reasons and safe failure codes. The view refreshes while visible. Audits persist in the agent's orchestration database; memory dreaming retains its workspace audit files.

`beforeTokens` is the latest recorded context measurement, not a new tokenization of the transcript. Native `/compact` does not currently provide a verified post-compaction measurement, so `afterTokens` stays unknown and appears as **—**. It is not reported as zero or an estimated saving. Compaction itself calls the model and can consume provider quota; `thresholdPercent` is a trigger, not a promised resulting context size.
