import { readFileSync } from 'fs';
import { join } from 'path';
import { extractFrontmatter } from '../skills/parser';
import { Effort, isEffort } from '../agent/model-registry';

export interface PstackAgentTemplate { body: string; effort?: Effort }

/**
 * The agents pstack's plugin.json declares (`pstack:poteto-agent`,
 * `pstack:effort-high`, …), read from the installed plugin when a subagent is
 * spawned. Natively the definition is the subagent's system prompt and its
 * `effort` the subagent's effort; the frontmatter `model` is never used, the
 * caller always passes the model.
 */
export function pstackAgentTemplates(installPath: string): Map<string, PstackAgentTemplate> {
  const templates = new Map<string, PstackAgentTemplate>();
  let files: unknown;
  try { files = JSON.parse(readFileSync(join(installPath, '.claude-plugin', 'plugin.json'), 'utf8')).agents; } catch { return templates; }
  if (!Array.isArray(files)) return templates;
  for (const file of files) {
    if (typeof file !== 'string' || file.includes('..')) continue;
    try {
      const parsed = extractFrontmatter(readFileSync(join(installPath, file), 'utf8'));
      const name = parsed?.frontmatter.name;
      if (typeof name !== 'string' || !name) continue;
      const effort = (parsed!.frontmatter as Record<string, unknown>).effort;
      templates.set(`pstack:${name}`, { body: parsed!.body, ...(isEffort(effort) ? { effort } : {}) });
    } catch { /* An unreadable agent file is simply not offered. */ }
  }
  return templates;
}
