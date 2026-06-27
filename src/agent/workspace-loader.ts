import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceFiles, LoadedWorkspace, WatchHandle } from '../types';
import { createWatcher } from '../watch/factory';
import { loadSkills, renderSkillsSection } from '../skills';

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

  const agentMd = truncateResult(rawAgent);
  const identityMd = truncateResult(rawIdentity);
  const soulMd = truncateResult(rawSoul);
  const userMd = truncateResult(rawUser);
  const heartbeatMd = truncateResult(rawHeartbeat);
  const memoryMd = truncateResult(rawMemory);

  // Load agent skills
  const skillRegistry = loadSkills({
    workspaceDir,
    mcpToolsDir: opts?.mcpToolsDir,
    sharedSkillsDir: opts?.sharedSkillsDir,
    logger: opts?.logger,
  });
  const skillsSection = renderSkillsSection(skillRegistry);

  // Assemble system prompt
  let systemPrompt =
    `--- MEMORY RULE ---\n${MEMORY_RULE}\n\n` +
    `--- AGENT IDENTITY ---\n${agentMd}\n\n` +
    `--- IDENTITY ---\n${identityMd}\n\n` +
    `--- SOUL ---\n${soulMd}\n\n` +
    `--- USER PROFILE ---\n${userMd}\n\n` +
    (skillsSection ? `--- AVAILABLE SKILLS ---\n${skillsSection}\n\n` : '') +
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
 * memory rule (see MEMORY_RULE above). When ONLY these change, a busy session
 * must not be force-restarted: the change most likely came from that very
 * session mid-turn, and a deferred restart would stop it the moment the turn
 * completes (the self-restart footgun). Idle sessions are still restarted so
 * the change reaches them on their next spawn, and the recomposed CLAUDE.md
 * carries the change into every future spawn regardless.
 */
export const AGENT_WRITABLE_FILES = new Set<string>([
  'MEMORY.md',
  'USER.md',
  'SOUL.md',
  'AGENTS.md',
]);

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

