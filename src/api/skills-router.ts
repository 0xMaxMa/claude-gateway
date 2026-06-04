import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentConfig, ApiKey } from '../types';
import { createApiAuthMiddleware, canAccessAgent, canWriteAgent, isAdmin } from './auth';
import { loadSkills } from '../skills/loader';
import { extractFrontmatter } from '../skills/parser';
import type { AgentRunner } from '../agent/runner';

type AuthedRequest = Request & { apiKey: ApiKey };

const SHARED_SKILLS_DIR = path.join(os.homedir(), '.claude-gateway', 'shared-skills');
const MCP_TOOLS_DIR = path.resolve(__dirname, '..', '..', 'mcp', 'tools');
const MAX_SKILL_SIZE = 100 * 1024; // 100KB

// Skill name validation: lowercase alphanumeric + hyphens, 1-64 chars
const VALID_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RESERVED_NAMES = new Set([
  'help', 'sessions', 'session', 'new', 'clear', 'compact',
  'rename', 'model', 'restart', 'access', 'configure',
]);

function validateSkillName(name: string): string | null {
  if (!VALID_NAME_RE.test(name)) {
    return `Invalid skill name "${name}". Must be lowercase alphanumeric with hyphens, 1-64 chars.`;
  }
  if (RESERVED_NAMES.has(name)) {
    return `Skill name "${name}" is reserved.`;
  }
  return null;
}

function getSkillDir(scope: 'workspace' | 'shared', name: string, workspaceDir: string): string {
  return scope === 'workspace'
    ? path.join(workspaceDir, 'skills', name)
    : path.join(SHARED_SKILLS_DIR, name);
}

function isPrivateHost(urlStr: string): boolean {
  try {
    const { hostname } = new URL(urlStr);
    // Node.js keeps brackets for IPv6 literals — strip them for matching
    const h = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
    return (
      h === 'localhost' ||
      /^127\./.test(h) ||
      /^10\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^169\.254\./.test(h) ||
      h === '::1' ||
      /^fe80:/i.test(h) ||                   // IPv6 link-local fe80::/10
      /^fc[0-9a-f]{2}:/i.test(h) ||          // IPv6 ULA fc00::/7
      /^fd[0-9a-f]{2}:/i.test(h)             // IPv6 ULA fd00::/8
    );
  } catch {
    return true; // block if URL cannot be parsed
  }
}

function toRawGitHubUrl(url: string): string {
  if (url.includes('raw.githubusercontent.com')) return url;
  const match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(tree|blob)\/([^/]+)\/(.+)$/);
  if (match) {
    const [, owner, repo, , branch, filePath] = match;
    const finalPath = filePath.endsWith('SKILL.md') ? filePath : `${filePath}/SKILL.md`;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${finalPath}`;
  }
  return url;
}

/**
 * Extract source_url from a SKILL.md file's frontmatter (homepage field),
 * or return null if not present.
 */
function extractSourceUrl(filePath: string): string | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const extracted = extractFrontmatter(raw);
    if (!extracted) return null;
    const homepage = extracted.frontmatter['homepage'];
    return typeof homepage === 'string' ? homepage : null;
  } catch {
    return null;
  }
}

function reloadRunnerRegistry(
  agentId: string,
  config: AgentConfig,
  agents: Map<string, AgentRunner>,
): void {
  const runner = agents.get(agentId);
  if (!runner) return;
  const registry = loadSkills({
    workspaceDir: config.workspace,
    mcpToolsDir: MCP_TOOLS_DIR,
    sharedSkillsDir: SHARED_SKILLS_DIR,
  });
  runner.setSkillRegistry(registry);
}

export function createSkillsRouter(
  agentConfigs: Map<string, AgentConfig>,
  apiKeys: ApiKey[],
  agents?: Map<string, AgentRunner>,
): Router {
  const router = Router();
  const auth = createApiAuthMiddleware(apiKeys);

  /**
   * GET /api/v1/agents/:agentId/skills
   * List all skills (workspace + module + shared).
   * Uses the runner's cached registry when available; falls back to a fresh load.
   */
  router.get('/v1/agents/:agentId/skills', auth, (req: Request, res: Response) => {
    const { agentId } = req.params as { agentId: string };
    const apiKey = (req as AuthedRequest).apiKey;

    if (!canAccessAgent(apiKey, agentId)) {
      res.status(403).json({ error: `API key has no access to agent '${agentId}'` });
      return;
    }

    const config = agentConfigs.get(agentId);
    if (!config) {
      res.status(404).json({ error: `Agent '${agentId}' not found` });
      return;
    }

    const runner = agents?.get(agentId);
    const registry = runner
      ? runner.getSkillRegistry()
      : loadSkills({ workspaceDir: config.workspace, mcpToolsDir: MCP_TOOLS_DIR, sharedSkillsDir: SHARED_SKILLS_DIR });

    const skills = [...registry.skills.entries()].map(([key, skill]) => ({
      key,
      name: skill.name,
      description: skill.description,
      scope: skill.source,
      emoji: skill.emoji ?? null,
      userInvocable: skill.userInvocable,
      modulePrefix: skill.modulePrefix ?? null,
      source_url: extractSourceUrl(skill.filePath),
    }));

    res.json(skills);
  });

  /**
   * GET /api/v1/agents/:agentId/skills/:name
   * Get a single skill's content.
   * Uses the runner's cached registry when available; falls back to a fresh load.
   */
  router.get('/v1/agents/:agentId/skills/:name', auth, (req: Request, res: Response) => {
    const { agentId, name } = req.params as { agentId: string; name: string };
    const apiKey = (req as AuthedRequest).apiKey;

    if (!canAccessAgent(apiKey, agentId)) {
      res.status(403).json({ error: `API key has no access to agent '${agentId}'` });
      return;
    }

    const config = agentConfigs.get(agentId);
    if (!config) {
      res.status(404).json({ error: `Agent '${agentId}' not found` });
      return;
    }

    const runner = agents?.get(agentId);
    const registry = runner
      ? runner.getSkillRegistry()
      : loadSkills({ workspaceDir: config.workspace, mcpToolsDir: MCP_TOOLS_DIR, sharedSkillsDir: SHARED_SKILLS_DIR });

    const scopeFilter = req.query['scope'] as string | undefined;

    // Find skill by name, optionally filtered by scope.
    // Module skills are keyed as "prefix:name" (e.g. "cron:cron") so a direct
    // get(name) may miss them — fall back to a linear search by name+source.
    let skill = registry.skills.get(name);
    if (scopeFilter && skill && skill.source !== scopeFilter) {
      // Direct key hit has the wrong scope — search by name within the requested scope.
      const scopedMatch = [...registry.skills.values()].find(
        (s) => s.name === name && s.source === scopeFilter,
      );
      skill = scopedMatch ?? undefined;
    }
    if (!skill && scopeFilter) {
      // Direct key miss — search by name+scope (covers module skills keyed as prefix:name).
      skill = [...registry.skills.values()].find(
        (s) => s.name === name && s.source === scopeFilter,
      );
    }

    if (!skill) {
      res.status(404).json({ error: `Skill '${name}' not found${scopeFilter ? ` in scope '${scopeFilter}'` : ''}` });
      return;
    }

    let rawContent = '';
    try {
      rawContent = fs.readFileSync(skill.filePath, 'utf-8');
    } catch {
      rawContent = skill.content;
    }

    res.json({
      key: name,
      name: skill.name,
      description: skill.description,
      scope: skill.source,
      emoji: skill.emoji ?? null,
      content: rawContent,
      source_url: extractSourceUrl(skill.filePath),
    });
  });

  /**
   * POST /api/v1/agents/:agentId/skills
   * Create a new skill.
   * Body: { name, description, content, scope?: 'workspace' | 'shared' }
   */
  router.post('/v1/agents/:agentId/skills', auth, async (req: Request, res: Response) => {
    const { agentId } = req.params as { agentId: string };
    const apiKey = (req as AuthedRequest).apiKey;

    if (!canWriteAgent(apiKey, agentId)) {
      res.status(403).json({ error: 'Write permission required' });
      return;
    }

    const config = agentConfigs.get(agentId);
    if (!config) {
      res.status(404).json({ error: `Agent '${agentId}' not found` });
      return;
    }

    const body = req.body as { name?: unknown; description?: unknown; content?: unknown; scope?: unknown };

    if (typeof body.name !== 'string' || !body.name.trim()) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    if (typeof body.description !== 'string' || !body.description.trim()) {
      res.status(400).json({ error: 'description is required' });
      return;
    }
    if (typeof body.content !== 'string' || !body.content.trim()) {
      res.status(400).json({ error: 'content is required' });
      return;
    }

    const name = body.name.trim();
    const description = body.description.trim();
    const content = body.content.trim();
    const scope = body.scope === 'shared' ? 'shared' : 'workspace';

    if (scope === 'shared' && !isAdmin(apiKey)) {
      res.status(403).json({ error: 'Admin key required for shared scope' });
      return;
    }

    const nameErr = validateSkillName(name);
    if (nameErr) {
      res.status(400).json({ error: nameErr });
      return;
    }

    const skillDir = getSkillDir(scope, name, config.workspace);
    const skillFile = path.join(skillDir, 'SKILL.md');

    if (fs.existsSync(skillFile)) {
      res.status(409).json({ error: `Skill "${name}" already exists. Delete it first or choose a different name.` });
      return;
    }

    const skillMd = `---\nname: ${name}\ndescription: "${description.replace(/"/g, '\\"')}"\n---\n\n${content}`;

    try {
      fs.mkdirSync(skillDir, { recursive: true });
      const tmpFile = skillFile + '.tmp';
      fs.writeFileSync(tmpFile, skillMd, 'utf-8');
      fs.renameSync(tmpFile, skillFile);
      if (agents) reloadRunnerRegistry(agentId, config, agents);
      res.status(201).json({
        key: name,
        name,
        description,
        scope,
        emoji: null,
        userInvocable: true,
        modulePrefix: null,
        content: skillMd,
        source_url: null,
      });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * POST /api/v1/agents/:agentId/skills/install
   * Install a skill from a GitHub or raw URL.
   * Body: { url, scope?: 'workspace' | 'shared', name?, force? }
   */
  router.post('/v1/agents/:agentId/skills/install', auth, async (req: Request, res: Response) => {
    const { agentId } = req.params as { agentId: string };
    const apiKey = (req as AuthedRequest).apiKey;

    if (!isAdmin(apiKey)) {
      res.status(403).json({ error: 'Admin key required to install skills from URL' });
      return;
    }

    const config = agentConfigs.get(agentId);
    if (!config) {
      res.status(404).json({ error: `Agent '${agentId}' not found` });
      return;
    }

    const body = req.body as { url?: unknown; scope?: unknown; name?: unknown; force?: unknown };

    if (typeof body.url !== 'string' || !body.url.trim()) {
      res.status(400).json({ error: 'url is required' });
      return;
    }

    const url = body.url.trim();
    if (!url.startsWith('https://')) {
      res.status(400).json({ error: 'Only HTTPS URLs are supported' });
      return;
    }

    if (isPrivateHost(url)) {
      res.status(400).json({ error: 'URL targets a private/internal address' });
      return;
    }

    const rawUrl = toRawGitHubUrl(url);
    const scope = body.scope === 'shared' ? 'shared' : 'workspace';
    const force = body.force === true;

    try {
      const response = await fetch(rawUrl, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) {
        res.status(400).json({ error: `Failed to fetch URL: ${response.status} ${response.statusText}` });
        return;
      }

      const content = await response.text();

      if (content.length > MAX_SKILL_SIZE) {
        res.status(400).json({ error: `SKILL.md exceeds ${MAX_SKILL_SIZE / 1024}KB limit` });
        return;
      }

      const extracted = extractFrontmatter(content);
      if (!extracted) {
        res.status(400).json({ error: 'Invalid SKILL.md: no valid YAML frontmatter found' });
        return;
      }

      const fm = extracted.frontmatter;
      const skillName = (typeof body.name === 'string' && body.name.trim())
        ? body.name.trim()
        : (typeof fm['name'] === 'string' ? fm['name'] : '');

      if (!skillName) {
        res.status(400).json({ error: 'Could not determine skill name from frontmatter. Use the name parameter.' });
        return;
      }

      const nameErr = validateSkillName(skillName);
      if (nameErr) {
        res.status(400).json({ error: nameErr });
        return;
      }

      const skillDir = getSkillDir(scope, skillName, config.workspace);
      const skillFile = path.join(skillDir, 'SKILL.md');

      if (fs.existsSync(skillFile) && !force) {
        res.status(409).json({ error: `Skill "${skillName}" already exists. Use force: true to overwrite.` });
        return;
      }

      fs.mkdirSync(skillDir, { recursive: true });
      const tmpFile = skillFile + '.tmp';
      fs.writeFileSync(tmpFile, content, 'utf-8');
      fs.renameSync(tmpFile, skillFile);
      if (agents) reloadRunnerRegistry(agentId, config, agents);
      const description = typeof fm['description'] === 'string' ? fm['description'] : '(no description)';
      res.status(201).json({
        key: skillName,
        name: skillName,
        description,
        scope,
        emoji: typeof fm['emoji'] === 'string' ? fm['emoji'] : null,
        userInvocable: true,
        modulePrefix: null,
        content,
        source_url: url,
      });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * DELETE /api/v1/agents/:agentId/skills/:name
   * Delete a skill by name.
   * Query: scope=workspace|shared (default: workspace)
   */
  router.delete('/v1/agents/:agentId/skills/:name', auth, (req: Request, res: Response) => {
    const { agentId, name } = req.params as { agentId: string; name: string };
    const apiKey = (req as AuthedRequest).apiKey;

    if (!canWriteAgent(apiKey, agentId)) {
      res.status(403).json({ error: 'Write permission required' });
      return;
    }

    const config = agentConfigs.get(agentId);
    if (!config) {
      res.status(404).json({ error: `Agent '${agentId}' not found` });
      return;
    }

    const scope = req.query['scope'] === 'shared' ? 'shared' : 'workspace';

    if (scope === 'shared' && !isAdmin(apiKey)) {
      res.status(403).json({ error: 'Admin key required for shared scope' });
      return;
    }
    const skillDir = getSkillDir(scope, name, config.workspace);
    const skillFile = path.join(skillDir, 'SKILL.md');

    if (!fs.existsSync(skillFile)) {
      res.status(404).json({ error: `Skill "${name}" not found in ${scope}` });
      return;
    }

    try {
      fs.rmSync(skillDir, { recursive: true, force: true });
      if (agents) reloadRunnerRegistry(agentId, config, agents);
      res.json({ message: `Skill "${name}" deleted from ${scope}` });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
