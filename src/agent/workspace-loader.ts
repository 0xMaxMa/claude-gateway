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
 * Watch a workspace directory for changes.
 * Calls onChange when any .md file changes (debounced 300ms).
 * If a file matching a known lowercase alias is added, it is auto-renamed to
 * its uppercase canonical name before triggering onChange.
 * Returns a WatchHandle with a close() method.
 */
export function watchWorkspace(workspaceDir: string, onChange: () => void): WatchHandle {
  return createWatcher({
    paths: [path.join(workspaceDir, '*.md')],
    debounceMs: WATCH_DEBOUNCE_MS,
    chokidarOpts: { ignored: path.join(workspaceDir, 'CLAUDE.md') },
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
    onChange,
  });
}

