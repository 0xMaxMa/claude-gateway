/**
 * Skill management handlers: create, delete, install.
 * Pure functions operating on the filesystem — no MCP dependency.
 */

import * as fs from 'fs';
import * as path from 'path';

// Skill name validation: lowercase alphanumeric + hyphens, 1-64 chars
const VALID_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Reserved names that conflict with system commands
const RESERVED_NAMES = new Set([
  'help', 'sessions', 'session', 'new', 'clear', 'compact',
  'rename', 'model', 'restart', 'access', 'configure',
]);

const MAX_SKILL_SIZE = 100 * 1024; // 100KB

function validateName(name: string): string | null {
  if (!VALID_NAME_RE.test(name)) {
    return `Invalid skill name "${name}". Must be lowercase alphanumeric with hyphens, 1-64 chars.`;
  }
  if (RESERVED_NAMES.has(name)) {
    return `Skill name "${name}" is reserved. Choose a different name.`;
  }
  return null;
}

function getSkillDir(scope: 'workspace' | 'shared', name: string, workspaceDir: string, sharedSkillsDir: string): string {
  if (scope === 'workspace') {
    return path.join(workspaceDir, 'skills', name);
  }
  return path.join(sharedSkillsDir, name);
}

export interface CreateSkillParams {
  name: string;
  description: string;
  content: string;
  scope: 'workspace' | 'shared';
  workspaceDir: string;
  sharedSkillsDir: string;
}

/**
 * Create a new skill by writing a SKILL.md file with proper frontmatter.
 */
export async function createSkill(params: CreateSkillParams): Promise<string> {
  const { name, description, content, scope, workspaceDir, sharedSkillsDir } = params;

  const nameError = validateName(name);
  if (nameError) throw new Error(nameError);

  const skillDir = getSkillDir(scope, name, workspaceDir, sharedSkillsDir);
  const skillFile = path.join(skillDir, 'SKILL.md');

  if (fs.existsSync(skillFile)) {
    throw new Error(`Skill "${name}" already exists at ${skillDir}. Use skill_delete first or choose a different name.`);
  }

  // Build SKILL.md with frontmatter
  const skillMd = [
    '---',
    `name: ${name}`,
    `description: "${description.replace(/"/g, '\\"')}"`,
    '---',
    '',
    content,
  ].join('\n');

  // Atomic write: create dir, write to .tmp, rename
  fs.mkdirSync(skillDir, { recursive: true });
  const tmpFile = skillFile + '.tmp';
  fs.writeFileSync(tmpFile, skillMd, 'utf-8');
  fs.renameSync(tmpFile, skillFile);

  return `Skill "${name}" created at ${skillFile} (scope: ${scope})`;
}

export interface DeleteSkillParams {
  name: string;
  scope: 'workspace' | 'shared';
  workspaceDir: string;
  sharedSkillsDir: string;
}

/**
 * Delete a skill by removing its directory.
 */
export async function deleteSkill(params: DeleteSkillParams): Promise<string> {
  const { name, scope, workspaceDir, sharedSkillsDir } = params;

  const skillDir = getSkillDir(scope, name, workspaceDir, sharedSkillsDir);
  const skillFile = path.join(skillDir, 'SKILL.md');

  if (!fs.existsSync(skillFile)) {
    throw new Error(`Skill "${name}" not found in ${scope} (looked at ${skillDir})`);
  }

  fs.rmSync(skillDir, { recursive: true, force: true });

  return `Skill "${name}" deleted from ${scope}`;
}

export interface InstallSkillParams {
  url: string;
  scope: 'workspace' | 'shared';
  name?: string;
  force?: boolean;
  workspaceDir: string;
  sharedSkillsDir: string;
}

/**
 * Convert a github.com URL to raw.githubusercontent.com.
 * e.g. https://github.com/user/repo/tree/main/skills/foo/SKILL.md
 *   -> https://raw.githubusercontent.com/user/repo/main/skills/foo/SKILL.md
 */
export function toRawGitHubUrl(url: string): string {
  // Already raw
  if (url.includes('raw.githubusercontent.com')) return url;

  // GitHub blob/tree URL pattern
  const match = url.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(tree|blob)\/([^/]+)\/(.+)$/
  );
  if (match) {
    const [, owner, repo, , branch, filePath] = match;
    // If the URL points to a directory, append /SKILL.md
    const finalPath = filePath.endsWith('SKILL.md') ? filePath : `${filePath}/SKILL.md`;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${finalPath}`;
  }

  return url;
}

/**
 * Install a skill from a URL by fetching SKILL.md and writing it locally.
 */
export async function installSkill(params: InstallSkillParams): Promise<string> {
  const { url, scope, force, workspaceDir, sharedSkillsDir } = params;

  // Security: only allow HTTPS
  if (!url.startsWith('https://')) {
    throw new Error('Only HTTPS URLs are supported for security.');
  }

  const rawUrl = toRawGitHubUrl(url);

  // Fetch content
  const response = await fetch(rawUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${rawUrl}: ${response.status} ${response.statusText}`);
  }

  const content = await response.text();

  // Size check
  if (content.length > MAX_SKILL_SIZE) {
    throw new Error(`SKILL.md exceeds ${MAX_SKILL_SIZE / 1024}KB limit (${(content.length / 1024).toFixed(1)}KB)`);
  }

  // Parse frontmatter to extract name. Import compiled dist/, not raw src/ —
  // src/ is not published (files: ["mcp/"]), so a src/ import throws "Cannot find
  // module" on installed packages. Enforced by mcp-no-src-imports.test.ts.
  const { extractFrontmatter } = await import('../../../dist/skills/parser.js');
  const extracted = extractFrontmatter(content);
  if (!extracted) {
    throw new Error('Invalid SKILL.md: no valid YAML frontmatter found.');
  }

  const fm = extracted.frontmatter;
  const skillName = params.name || (typeof fm.name === 'string' ? fm.name : '');
  if (!skillName) {
    throw new Error('Invalid SKILL.md: missing "name" in frontmatter. Use the name parameter to override.');
  }

  const nameError = validateName(skillName);
  if (nameError) throw new Error(nameError);

  const skillDir = getSkillDir(scope, skillName, workspaceDir, sharedSkillsDir);
  const skillFile = path.join(skillDir, 'SKILL.md');

  if (fs.existsSync(skillFile) && !force) {
    throw new Error(`Skill "${skillName}" already exists. Use force: true to overwrite.`);
  }

  // Write skill file (atomic)
  fs.mkdirSync(skillDir, { recursive: true });
  const tmpFile = skillFile + '.tmp';
  fs.writeFileSync(tmpFile, content, 'utf-8');
  fs.renameSync(tmpFile, skillFile);

  const description = typeof fm.description === 'string' ? fm.description : '(no description)';

  return `Skill "${skillName}" installed from ${rawUrl} (scope: ${scope})\nDescription: ${description}`;
}
