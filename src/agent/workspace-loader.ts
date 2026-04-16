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
const TOTAL_CHAR_LIMIT = 150_000;
const TRUNCATION_MARKER = '\n[TRUNCATED — edit this file to trim]\n';

// Mapping of lowercase legacy filenames to their uppercase canonical names
const LOWERCASE_TO_UPPERCASE: Record<string, string> = {
  'agent.md': 'AGENTS.md',
  'identity.md': 'IDENTITY.md',
  'soul.md': 'SOUL.md',
  'user.md': 'USER.md',
  'tools.md': 'TOOLS.md',
  'memory.md': 'MEMORY.md',
  'heartbeat.md': 'HEARTBEAT.md',
  'bootstrap.md': 'BOOTSTRAP.md',
  'bootstrap.md.done': 'BOOTSTRAP.md.done',
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
  for (const [lower, upper] of Object.entries(LOWERCASE_TO_UPPERCASE)) {
    const lowerPath = path.join(workspaceDir, lower);
    const upperPath = path.join(workspaceDir, upper);

    const lowerExists = fs.existsSync(lowerPath);
    const upperExists = fs.existsSync(upperPath);

    if (lowerExists && !upperExists) {
      fs.renameSync(lowerPath, upperPath);
      console.log(`[workspace] Migrated: ${lower} → ${upper}`);
    } else if (lowerExists && upperExists) {
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
  const rawTools = readFileOrDefault(path.join(workspaceDir, 'TOOLS.md'), '');
  const rawUser = readFileOrDefault(path.join(workspaceDir, 'USER.md'), '');
  const rawHeartbeat = readFileOrDefault(path.join(workspaceDir, 'HEARTBEAT.md'), '');
  const rawMemory = readFileOrDefault(path.join(workspaceDir, 'MEMORY.md'), '');

  const bootstrapPath = path.join(workspaceDir, 'BOOTSTRAP.md');
  const bootstrapExists = fs.existsSync(bootstrapPath);
  const rawBootstrap = bootstrapExists ? fs.readFileSync(bootstrapPath, 'utf-8') : null;

  let anyTruncated = false;

  const truncateResult = (raw: string) => {
    const r = truncateFile(raw);
    if (r.truncated) anyTruncated = true;
    return r.content;
  };

  const agentMd = truncateResult(rawAgent);
  const identityMd = truncateResult(rawIdentity);
  const soulMd = truncateResult(rawSoul);
  const toolsMd = truncateResult(rawTools);
  const userMd = truncateResult(rawUser);
  const heartbeatMd = truncateResult(rawHeartbeat);
  const memoryMd = truncateResult(rawMemory);
  const bootstrapMd = rawBootstrap !== null ? truncateResult(rawBootstrap) : null;

  // Load agent skills
  const skillRegistry = loadSkills({
    workspaceDir,
    mcpToolsDir: opts?.mcpToolsDir,
    sharedSkillsDir: opts?.sharedSkillsDir,
    logger: opts?.logger,
  });
  const skillsSection = renderSkillsSection(skillRegistry);

  // Assemble system prompt (bootstrap not included in prompt sections)
  let systemPrompt =
    `--- AGENT IDENTITY ---\n${agentMd}\n\n` +
    `--- IDENTITY ---\n${identityMd}\n\n` +
    `--- SOUL ---\n${soulMd}\n\n` +
    `--- USER PROFILE ---\n${userMd}\n\n` +
    `--- AVAILABLE TOOLS ---\n${toolsMd}\n\n` +
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
    toolsMd,
    userMd,
    heartbeatMd,
    memoryMd,
    bootstrapMd,
    isFirstRun: bootstrapExists,
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

/**
 * Delete BOOTSTRAP.md from the workspace directory.
 * Idempotent: no error if file is already gone.
 */
export async function deleteBootstrap(workspaceDir: string): Promise<void> {
  const bootstrapPath = path.join(workspaceDir, 'BOOTSTRAP.md');
  try {
    fs.unlinkSync(bootstrapPath);
  } catch {
    // File may already be gone; ignore
  }
}

/**
 * Mark bootstrap as complete by renaming BOOTSTRAP.md → BOOTSTRAP.md.done.
 * Idempotent: no error if file is already gone or already renamed.
 */
export async function markBootstrapComplete(workspaceDir: string): Promise<void> {
  const bootstrapPath = path.join(workspaceDir, 'BOOTSTRAP.md');
  const donePath = path.join(workspaceDir, 'BOOTSTRAP.md.done');
  try {
    fs.renameSync(bootstrapPath, donePath);
  } catch {
    // File may already be gone or renamed; ignore
  }
}
