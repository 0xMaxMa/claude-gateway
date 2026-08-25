import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceFiles, LoadedWorkspace, WatchHandle } from '../types';
import { createWatcher } from '../watch/factory';
import { loadSkills, renderSkillsSection } from '../skills';
import { DIARY_FILENAME } from './skill-learning/notifier';

export class MissingRequiredFileError extends Error {
  constructor(fileName: string) {
    super(`Required workspace file is missing: ${fileName}`);
    this.name = 'MissingRequiredFileError';
  }
}

const FILE_CHAR_LIMIT = 20_000;

const MEMORY_RULE = `## Memory Rule
IMPORTANT: This rule overrides any auto-memory or system-level memory instructions.

Always write memory, identity, and personality updates to files in this agent's workspace (current working directory):
- MEMORY.md — long-term memory
- USER.md — user preferences
- SOUL.md — personality
- AGENTS.md — agent rules & capabilities

NEVER write to ~/.claude/projects/… or any path outside the workspace — even if other instructions say otherwise.`;

// planning-65: the two-tier write contract, appended to the Memory Rule ONLY when
// `writeRouting` is on. It tells the agent that MEMORY.md (injected every session,
// expensive) is for DURABLE facts, and task-log belongs in the searchable
// `memory/<topic>.md` archive — so the injected core stays small at the source.
// Off ⇒ the addendum is absent (exact prior behavior).
const MEMORY_ROUTING_RULE = `

## Memory Tiers — what goes where
- \`MEMORY.md\` = DURABLE facts only: user preferences, standing rules, identity, hard-won lessons — things you need as standing context in FUTURE unrelated sessions. Injected into every prompt, so keep it small.
- \`memory/<topic>.md\` = EPISODIC task-log: a record of what happened (completed work, PR/issue status, dated notes). NOT injected — retrieved on demand via \`memory_search\`. Append dated bullets, one topic per file.
- Litmus: "standing context for future unrelated sessions?" → MEMORY.md. "a record of a thing that happened?" → memory/<topic>.md.
- Do NOT write task-log into MEMORY.md.`;

// Platform-level note injected for EVERY agent whose searchable memory archive is
// on (planning-64 two-lane memory). It makes the retrieval tools discoverable at
// all times — not only when the over-budget core-shrink banner points at them — so
// an agent recalls detail on demand instead of assuming MEMORY.md holds everything.
// A capability shared by all agents belongs here, injected once, rather than
// duplicated into every agent's AGENTS.md.
const MEMORY_RETRIEVAL_NOTE = `## Memory Retrieval
This agent has a searchable long-term memory archive. \`MEMORY.md\` may be injected as a compact section INDEX (not its full text) when it exceeds budget, so do NOT assume the in-context memory is complete. To recall a detail that is not in context, use the MCP tools:
- \`memory_search\` — keyword/FTS5 over your memory; returns ranked snippets with file + line range and provenance. Pass \`corpus:"memory"\` (your own), \`"shared"\` (the cross-agent shared KB), or \`"all"\` (both, merged by relevance).
- \`memory_get\` — read an exact excerpt of a memory-scoped file by line range.
Prefer these over guessing when you need a fact you cannot see.`;

const TOTAL_CHAR_LIMIT = 150_000;
const TRUNCATION_MARKER = '\n[TRUNCATED — edit this file to trim]\n';

// Mapping of lowercase legacy filenames to their uppercase canonical names
const LOWERCASE_TO_UPPERCASE: Record<string, string> = {
  'agent.md': 'AGENTS.md',
  'identity.md': 'IDENTITY.md',
  'soul.md': 'SOUL.md',
  'user.md': 'USER.md',
  'memory.md': 'MEMORY.md',
  'heartbeat.md': 'HEARTBEAT.md',
};

function readFileOrDefault(filePath: string, defaultValue: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return defaultValue;
  }
}

function truncateFile(content: string): { content: string; truncated: boolean } {
  if (content.length > FILE_CHAR_LIMIT) {
    return {
      content: content.slice(0, FILE_CHAR_LIMIT) + TRUNCATION_MARKER,
      truncated: true,
    };
  }
  return { content, truncated: false };
}

// ── Memory budget discipline (issue #323) ────────────────────────────────────
// Self-authored memory (MEMORY.md/USER.md) that grows past a SOFT budget gets a
// loud, actionable over-budget banner at compose time instead of a silent
// truncation, so the owning agent consolidates on its next spawn. The soft
// budget is well under the hard FILE_CHAR_LIMIT (still applied as a context
// safety net); the banner fires long before the hard cut.

export type OverBudgetMode = 'warn' | 'error';

export interface MemoryBudgetConfig {
  memoryBudgetChars: number; // soft budget for MEMORY.md
  userBudgetChars: number; // soft budget for USER.md
  // Compose-banner severity only in v1: 'warn' (⚠️) vs 'error' (🛑 + stronger
  // wording). Neither rejects the write — a hard-reject memory tool is a planned
  // follow-up; at compose there is nothing to reject.
  overBudget: OverBudgetMode;
  // planning-65: inject the two-tier write contract into the Memory Rule so agents
  // route task-log to memory/<topic>.md instead of MEMORY.md. Default false (opt-in
  // kill-switch); the gateway passes the resolved config value.
  writeRouting: boolean;
}

const DEFAULT_MEMORY_BUDGET_CHARS = 8_000;
const DEFAULT_USER_BUDGET_CHARS = 3_000;

export const DEFAULT_MEMORY_BUDGET: MemoryBudgetConfig = {
  memoryBudgetChars: DEFAULT_MEMORY_BUDGET_CHARS,
  userBudgetChars: DEFAULT_USER_BUDGET_CHARS,
  overBudget: 'warn',
  writeRouting: false,
};

/**
 * Resolve a (possibly partial or malformed) memory-budget config into a complete
 * one, falling back to the documented defaults. An unknown `overBudget` value or
 * a non-numeric / negative budget is treated as "not set" and defaulted, so bad
 * operator config never throws at compose (fail-safe, mirrors #310's tz guard).
 */
export function resolveMemoryBudget(cfg?: Partial<MemoryBudgetConfig>): MemoryBudgetConfig {
  const overBudget: OverBudgetMode = cfg?.overBudget === 'error' ? 'error' : 'warn';
  const memoryBudgetChars =
    typeof cfg?.memoryBudgetChars === 'number' && cfg.memoryBudgetChars >= 0
      ? cfg.memoryBudgetChars
      : DEFAULT_MEMORY_BUDGET_CHARS;
  const userBudgetChars =
    typeof cfg?.userBudgetChars === 'number' && cfg.userBudgetChars >= 0
      ? cfg.userBudgetChars
      : DEFAULT_USER_BUDGET_CHARS;
  const writeRouting = cfg?.writeRouting === true;
  return { memoryBudgetChars, userBudgetChars, overBudget, writeRouting };
}

/**
 * Build a compact, injectable INDEX of an over-budget MEMORY.md (planning-64 K2
 * core-shrink): the section headings, each top-level (`#`/`##`) section with a
 * short brief, plus a pointer telling the agent the full content lives on disk and
 * is reachable via the `memory_search` / `memory_get` tools. Derived
 * deterministically from the file structure — NO LLM and NO mutation of the
 * on-disk file. Fenced code blocks are skipped so a `# comment` inside ``` is not
 * mistaken for a heading. Returns `null` when the file has no headings to index
 * (caller then keeps full content).
 */
export function buildMemoryIndex(content: string, maxChars = 4000): string | null {
  const lines = content.split('\n');
  const headings: string[] = [];
  const isFence = (line: string): boolean => /^\s*(```|~~~)/.test(line);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (isFence(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i]);
    if (!m) continue;
    headings.push(m[0].trim());
    // A one-line brief for top-level (# / ##) sections: first non-empty,
    // non-heading, non-fence line beneath the heading.
    if (m[1].length <= 2) {
      let fenced = false;
      for (let j = i + 1; j < lines.length; j++) {
        if (isFence(lines[j])) {
          fenced = !fenced;
          continue;
        }
        if (fenced) continue;
        const nx = lines[j].trim();
        if (!nx) continue;
        if (/^#{1,6}\s/.test(nx)) break;
        const body = nx.replace(/^[-*]\s+/, '');
        headings.push(`    ${body.slice(0, 100)}${body.length > 100 ? '…' : ''}`);
        break;
      }
    }
  }
  if (headings.length === 0) return null; // nothing to index → keep full content

  let index = headings.join('\n');
  if (index.length > maxChars) index = `${index.slice(0, maxChars)}\n…`;
  const pointer =
    `📇 This is an INDEX of your long-term memory — the full content is over budget so it lives ` +
    `on disk (and in your searchable archive), NOT in this prompt. To recall a detail, use the ` +
    `memory_search tool (keyword → snippets with file+line) or memory_get (read a section). ` +
    `Section map:\n\n`;
  return pointer + index;
}

/**
 * Prepend a loud over-budget banner to a memory file's composed content when it
 * exceeds its soft budget. Returns the content unchanged when under budget (or
 * when the budget is 0 / disabled). The hard FILE_CHAR_LIMIT truncation is
 * applied separately afterwards as a context safety net.
 *
 * `shrink` (K2, MEMORY.md only): when the file is over budget and this returns a
 * non-null replacement (the compact index), the banner is prepended to THAT
 * instead of the full content — so the bulk never enters the prompt. The on-disk
 * file is untouched; the full content stays searchable via the archive tools.
 */
function applyMemoryBudget(
  content: string,
  budgetChars: number,
  label: string,
  mode: OverBudgetMode,
  shrink?: (content: string) => string | null,
): { content: string; overBudget: boolean } {
  if (budgetChars <= 0 || content.length <= budgetChars) {
    return { content, overBudget: false };
  }
  const icon = mode === 'error' ? '🛑' : '⚠️';
  const shrunk = shrink ? shrink(content) : null;
  let banner: string;
  if (shrunk !== null) {
    // Shrink mode: only the INDEX below is loaded — the agent does NOT see the
    // actual entries, so it must not rewrite MEMORY.md from this prompt (that
    // would clobber the un-shown full content on disk). Point it at the tools.
    const must = mode === 'error' ? 'MUST ' : '';
    banner =
      `${icon} ${label} OVER BUDGET: ${content.length}/${budgetChars} chars — only the section INDEX ` +
      `below is loaded; the full entries live on disk. ${must}consolidate by reading them with ` +
      `memory_search / memory_get FIRST, then editing MEMORY.md on disk — never rewrite it from this ` +
      `prompt (you would lose the entries not shown). Edits apply on the next session spawn ` +
      `(frozen-at-spawn), no restart.\n\n`;
  } else {
    const action = mode === 'error' ? 'MUST consolidate now' : 'consolidate';
    banner =
      `${icon} ${label} OVER BUDGET: ${content.length}/${budgetChars} chars — ${action}: ` +
      `keep the highest-value facts, remove stale or duplicate entries. ` +
      `Edits apply on the next session spawn (frozen-at-spawn), no restart.\n\n`;
  }
  return { content: banner + (shrunk ?? content), overBudget: true };
}

/**
 * Migrate workspace files from legacy lowercase names to uppercase canonical names.
 * - If lowercase exists and uppercase does NOT: rename lowercase → uppercase
 * - If BOTH exist: remove lowercase, keep uppercase
 * Also handles bootstrap.md.done → BOOTSTRAP.md.done
 */
export function migrateWorkspaceFiles(workspaceDir: string): void {
  // Use readdirSync for case-sensitive filename matching on all platforms.
  // fs.existsSync is case-insensitive on Windows, causing both lowerExists and
  // upperExists to resolve to the same file and delete the only copy.
  const dirFiles = new Set(fs.readdirSync(workspaceDir));

  for (const [lower, upper] of Object.entries(LOWERCASE_TO_UPPERCASE)) {
    const lowerExists = dirFiles.has(lower);
    const upperExists = dirFiles.has(upper);

    if (lowerExists && !upperExists) {
      const lowerPath = path.join(workspaceDir, lower);
      const upperPath = path.join(workspaceDir, upper);
      fs.renameSync(lowerPath, upperPath);
      console.log(`[workspace] Migrated: ${lower} → ${upper}`);
    } else if (lowerExists && upperExists) {
      const lowerPath = path.join(workspaceDir, lower);
      console.log(
        `[workspace] WARNING: both ${lower} and ${upper} exist — keeping ${upper}, removing ${lower}`
      );
      fs.unlinkSync(lowerPath);
    }
  }
}

export interface LoadWorkspaceOptions {
  mcpToolsDir?: string;
  sharedSkillsDir?: string;
  logger?: { warn: (msg: string) => void };
  /**
   * Soft per-file char budgets for MEMORY.md/USER.md. When omitted, the
   * documented defaults (DEFAULT_MEMORY_BUDGET) apply — so callers and tests
   * that don't pass it are unaffected.
   */
  memoryBudget?: Partial<MemoryBudgetConfig>;
  /**
   * K2 core-shrink (planning-64): when true, an over-budget MEMORY.md is injected
   * as a compact auto-generated index + a pointer to the memory_search tool,
   * instead of the banner + truncated full text. Defaults to FALSE (opt-in) — the
   * gateway sets it true only when the knowledge archive is enabled, so the index
   * pointer never references a tool that isn't wired.
   */
  coreShrink?: boolean;
}

/**
 * Load workspace markdown files and assemble the system prompt.
 */
export async function loadWorkspace(workspaceDir: string, opts?: LoadWorkspaceOptions): Promise<LoadedWorkspace> {
  const agentMdPath = path.join(workspaceDir, 'AGENTS.md');

  // AGENTS.md is required
  if (!fs.existsSync(agentMdPath)) {
    throw new MissingRequiredFileError('AGENTS.md');
  }

  const rawAgent = fs.readFileSync(agentMdPath, 'utf-8');
  const rawIdentity = readFileOrDefault(path.join(workspaceDir, 'IDENTITY.md'), '');
  const rawSoul = readFileOrDefault(path.join(workspaceDir, 'SOUL.md'), '');
  const rawUser = readFileOrDefault(path.join(workspaceDir, 'USER.md'), '');
  const rawHeartbeat = readFileOrDefault(path.join(workspaceDir, 'HEARTBEAT.md'), '');
  const rawMemory = readFileOrDefault(path.join(workspaceDir, 'MEMORY.md'), '');

  let anyTruncated = false;

  const truncateResult = (raw: string) => {
    const r = truncateFile(raw);
    if (r.truncated) anyTruncated = true;
    return r.content;
  };

  // Memory files (MEMORY.md/USER.md) get a loud over-budget banner at their soft
  // budget BEFORE the hard-limit truncation, so the agent gets an actionable
  // signal instead of a silent [TRUNCATED]. The banner sits at the top of the
  // section, so the per-file FILE_CHAR_LIMIT truncation (which trims the tail)
  // always leaves it intact. (An extreme TOTAL_CHAR_LIMIT overflow could still
  // slice it, but that path already truncates the whole prompt.)
  const budget = resolveMemoryBudget(opts?.memoryBudget);
  // K2 core-shrink (opt-in): when enabled AND MEMORY.md is over budget, inject a
  // compact auto-generated index + a pointer to memory_search instead of the
  // truncated full text. Defaults OFF so a caller that omits the flag never points
  // the agent at a memory_search tool that may not be wired; the gateway enables
  // it explicitly only when the knowledge archive is on. USER.md is never shrunk.
  const coreShrink = opts?.coreShrink === true;
  const memoryBudgeted = applyMemoryBudget(
    rawMemory,
    budget.memoryBudgetChars,
    'MEMORY.md',
    budget.overBudget,
    coreShrink ? (c) => buildMemoryIndex(c) : undefined,
  );
  const userBudgeted = applyMemoryBudget(rawUser, budget.userBudgetChars, 'USER.md', budget.overBudget);

  const agentMd = truncateResult(rawAgent);
  const identityMd = truncateResult(rawIdentity);
  const soulMd = truncateResult(rawSoul);
  const userMd = truncateResult(userBudgeted.content);
  const heartbeatMd = truncateResult(rawHeartbeat);
  const memoryMd = truncateResult(memoryBudgeted.content);

  // Load agent skills
  const skillRegistry = loadSkills({
    workspaceDir,
    mcpToolsDir: opts?.mcpToolsDir,
    sharedSkillsDir: opts?.sharedSkillsDir,
    logger: opts?.logger,
  });
  const skillsSection = renderSkillsSection(skillRegistry);

  // Assemble system prompt
  const memoryRuleSection = MEMORY_RULE + (budget.writeRouting ? MEMORY_ROUTING_RULE : '');
  let systemPrompt =
    `--- MEMORY RULE ---\n${memoryRuleSection}\n\n` +
    `--- AGENT IDENTITY ---\n${agentMd}\n\n` +
    `--- IDENTITY ---\n${identityMd}\n\n` +
    `--- SOUL ---\n${soulMd}\n\n` +
    `--- USER PROFILE ---\n${userMd}\n\n` +
    (skillsSection ? `--- AVAILABLE SKILLS ---\n${skillsSection}\n\n` : '') +
    (coreShrink ? `--- MEMORY RETRIEVAL ---\n${MEMORY_RETRIEVAL_NOTE}\n\n` : '') +
    `--- LONG-TERM MEMORY ---\n${memoryMd}\n\n` +
    `--- HEARTBEAT CONFIG ---\n${heartbeatMd}`;

  // Enforce total limit
  if (systemPrompt.length > TOTAL_CHAR_LIMIT) {
    systemPrompt = systemPrompt.slice(0, TOTAL_CHAR_LIMIT) + TRUNCATION_MARKER;
    anyTruncated = true;
  }

  const files: WorkspaceFiles = {
    agentMd,
    identityMd,
    soulMd,
    userMd,
    heartbeatMd,
    memoryMd,
  };

  return {
    systemPrompt,
    files,
    truncated: anyTruncated,
    skillRegistry,
  };
}

const WATCH_DEBOUNCE_MS = 300;

/**
 * Canonical workspace files the agent is authorized to write itself, per the
 * memory rule (see MEMORY_RULE above), split into two tiers by how urgently a
 * change needs to reach a running session — and, crucially, by the fact that
 * CLAUDE.md is frozen-at-spawn (a live process never re-reads it; the recomposed
 * file applies on the next natural spawn regardless).
 *
 * MEMORY_FILES — self-authored data the agent writes about itself/the user
 *   (MEMORY.md, USER.md). A write here is almost always the running session
 *   curating its own memory mid-work. Since the process already holds what it
 *   just wrote and every future spawn reads the recomposed CLAUDE.md, restarting
 *   ANY session (busy or idle) buys nothing — it only drops in-context state and
 *   forces a SQLite-replay respawn. Memory-only changes therefore restart
 *   nothing at all (see the watcher callback in src/index.ts).
 *
 * IDENTITY_FILES — operator-authored identity (SOUL.md, AGENTS.md, IDENTITY.md).
 *   These want to reach sessions "soon-ish", but still never justify SIGKILLing
 *   an idle bystander: a deferred restart (respawn on next message) is lossless
 *   and applies the change just as correctly. IDENTITY.md is API-writable and
 *   composed into CLAUDE.md exactly like SOUL/AGENTS, so it belongs in this tier
 *   for the same reason — omitting it would SIGKILL idle sessions on an
 *   IDENTITY.md write while deferring the semantically identical SOUL write.
 *
 * SKILL_LEARNING_FILES — the skill-learning diary (SKILLS_LEARNED.md, written by
 *   the auto skill-create/update pipeline, not the live conversation). Unlike
 *   MEMORY_FILES, the session whose transcript was reviewed is very often NOT
 *   the one that needs restarting — other idle sessions on the same agent don't
 *   already hold the new skill, so `none` would be wrong. It gets the same
 *   `defer-idle` treatment as IDENTITY_FILES instead: reach sessions on their
 *   next message, never SIGKILL one that's idle only because it dispatched a
 *   background Agent/Workflow sub-agent and is waiting on it (see
 *   hasLikelyOutstandingBackgroundWork() in session/process.ts — that guard
 *   covers every restart tier, but keeping this file out of the aggressive
 *   `restart` tier in the first place is the direct fix for the incident that
 *   surfaced it).
 */
export const MEMORY_FILES = new Set<string>(['MEMORY.md', 'USER.md']);
export const IDENTITY_FILES = new Set<string>(['SOUL.md', 'AGENTS.md', 'IDENTITY.md']);
export const SKILL_LEARNING_FILES = new Set<string>([DIARY_FILENAME]);

/**
 * Union of the two tiers — kept for callers that only need "did the agent write
 * this itself?" (e.g. the busy-session skip guard).
 */
export const AGENT_WRITABLE_FILES = new Set<string>([
  ...MEMORY_FILES,
  ...IDENTITY_FILES,
  ...SKILL_LEARNING_FILES,
]);

/**
 * How a workspace change should affect already-running sessions. CLAUDE.md is
 * always recomposed on disk regardless; this only decides the restart strategy.
 *
 *  - `none`        Restart nothing. Self-authored memory (MEMORY.md/USER.md):
 *                  the writing session already holds the change and every future
 *                  spawn reads the recomposed CLAUDE.md, so a restart is pure
 *                  downside. A memory write can never drop a live session.
 *  - `defer-idle`  Operator identity (SOUL.md/AGENTS.md/IDENTITY.md) or the
 *                  skill-learning diary (SKILLS_LEARNED.md), possibly mixed with
 *                  memory files: skip busy sessions (self-restart footgun) and
 *                  defer idle ones (lossless respawn on next message) — never
 *                  SIGKILL an idle bystander.
 *  - `restart`     Any non-agent-writable change (HEARTBEAT.md, operator config,
 *                  etc.) or an empty change list: today's normal restart-or-defer.
 */
export type WorkspaceRestartAction = 'none' | 'defer-idle' | 'restart';

export function classifyWorkspaceRestart(changedFiles: string[]): WorkspaceRestartAction {
  if (changedFiles.length === 0) return 'restart';
  if (changedFiles.every((f) => MEMORY_FILES.has(f))) return 'none';
  if (changedFiles.every((f) => AGENT_WRITABLE_FILES.has(f))) return 'defer-idle';
  return 'restart';
}

/**
 * Normalize a changed file path to its canonical uppercase basename, resolving
 * legacy lowercase aliases (e.g. memory.md → MEMORY.md).
 */
function canonicalWorkspaceName(filePath: string): string {
  const base = path.basename(filePath);
  return LOWERCASE_TO_UPPERCASE[base] ?? base;
}

/**
 * Watch a workspace directory for changes.
 * Calls onChange (debounced 300ms) with the de-duplicated list of canonical
 * filenames that changed (e.g. ['MEMORY.md', 'SOUL.md']).
 * If a file matching a known lowercase alias is added, it is auto-renamed to
 * its uppercase canonical name before triggering onChange.
 * Returns a WatchHandle with a close() method.
 */
export function watchWorkspace(
  workspaceDir: string,
  onChange: (changedFiles: string[]) => void,
): WatchHandle {
  const claudeMdPath = path.join(workspaceDir, 'CLAUDE.md');
  return createWatcher({
    paths: [path.join(workspaceDir, '*.md')],
    debounceMs: WATCH_DEBOUNCE_MS,
    // Only the top-level *.md files matter here. `depth: 0` and the `ignored`
    // function do TWO DISTINCT jobs — neither is redundant:
    //   • depth:0 stops chokidar from recursing into workspace subdirectories
    //     (.telegram-state / .discord-state / memory / …). That accidental
    //     recursion fanned out one inotify watcher per nested dir across every
    //     agent and could exhaust the system limit (ENOSPC), crashing the
    //     gateway. depth:0 alone does NOT filter top-level entries.
    //   • ignored filters the top-level entries the *.md glob still matches:
    //     CLAUDE.md (excluded so its reload-driven rewrite can't self-trigger a
    //     loop) and dot-prefixed files. NB: chokidar's *.md glob DOES match
    //     leading-dot files (verified — `.foo.md` fires an add event), so
    //     without this a top-level dotfile would spuriously trigger reloads.
    // The dot test is computed relative to workspaceDir on purpose — a naive
    // dot-segment match against the absolute path would also match the parent
    // `.claude-gateway` dir and silently ignore the entire tree.
    chokidarOpts: {
      depth: 0,
      ignored: (p: string) => {
        if (p === claudeMdPath) return true;
        const rel = path.relative(workspaceDir, p);
        return rel !== '' && rel.startsWith('.');
      },
    },
    onAddSync: (filePath: string) => {
      const filename = path.basename(filePath);
      const upperName = LOWERCASE_TO_UPPERCASE[filename];
      if (upperName) {
        const upperPath = path.join(workspaceDir, upperName);
        try {
          fs.renameSync(filePath, upperPath);
          console.log(`[workspace] Auto-renamed: ${filename} → ${upperName}`);
        } catch {
          // Ignore rename errors (file may have already been renamed)
        }
      }
    },
    onChange: (changedPaths: string[]) => {
      const names = Array.from(new Set(changedPaths.map(canonicalWorkspaceName)));
      onChange(names);
    },
  });
}

