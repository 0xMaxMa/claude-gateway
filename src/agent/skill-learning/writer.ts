/**
 * Skill writer — applies a validated ReviewProposal to disk.
 *
 * The gateway (this module), NOT the reviewer model, writes files. All the
 * safety guards live here:
 *   - name / reserved-name / size validation (mirrors mcp/tools/skills/handlers.ts
 *     — keep in sync; src/ cannot import from mcp/ because tsc rootDir is ./src).
 *   - HARD provenance guard: only `origin: auto` skills are ever edited or
 *     overwritten; a create that collides with a non-auto skill is refused.
 *   - priority/dedup: a create that duplicates an existing auto skill (by name
 *     or description) is downgraded to an edit of that skill.
 *   - `mode: propose` writes to a review queue (`skills/.pending/`) instead of live.
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractFrontmatter } from '../../skills/parser';
import type { ReviewProposal, WriteOutcome, SkillOrigin, SkillLearningMode } from './types';

// --- Guards mirrored from mcp/tools/skills/handlers.ts (keep in sync) ---------
const VALID_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RESERVED_NAMES = new Set([
  'help', 'sessions', 'session', 'new', 'clear', 'compact',
  'rename', 'model', 'restart', 'access', 'configure',
]);
const MAX_SKILL_SIZE = 100 * 1024; // 100KB

export const PENDING_DIRNAME = '.pending';

export interface ExistingSkill {
  name: string;
  description: string;
  origin: SkillOrigin;
  filePath: string;
}

export interface WriterContext {
  workspaceDir: string;
  sessionId: string;
  now: number;
  mode: SkillLearningMode;
  /** Existing skills for dedup + provenance decisions (name, desc, origin, path). */
  existing: ExistingSkill[];
}

function validateName(name: string): string | null {
  if (!VALID_NAME_RE.test(name)) {
    return `invalid skill name "${name}" (lowercase alphanumeric + hyphens, 1-64 chars)`;
  }
  if (RESERVED_NAMES.has(name)) return `skill name "${name}" is reserved`;
  return null;
}

/** Read the `origin` frontmatter of an on-disk skill; missing ⇒ 'user' (never writable). */
export function readSkillOrigin(filePath: string): SkillOrigin {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const fm = extractFrontmatter(raw)?.frontmatter;
    return fm && fm['origin'] === 'auto' ? 'auto' : 'user';
  } catch {
    return 'user';
  }
}

function buildSkillMd(opts: {
  name: string;
  description: string;
  body: string;
  origin: SkillOrigin;
  createdFromSession: string;
  createdAt: number;
  pinned: boolean;
}): string {
  const desc = opts.description.replace(/"/g, '\\"');
  return [
    '---',
    `name: ${opts.name}`,
    `description: "${desc}"`,
    `origin: ${opts.origin}`,
    `createdFromSession: ${opts.createdFromSession}`,
    `createdAt: ${opts.createdAt}`,
    `pinned: ${opts.pinned}`,
    '---',
    '',
    opts.body.trimEnd(),
    '',
  ].join('\n');
}

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, filePath);
}

/** Directory a skill (or its pending queue entry) is written to. */
function skillFilePath(workspaceDir: string, name: string, queued: boolean): string {
  const base = queued
    ? path.join(workspaceDir, 'skills', PENDING_DIRNAME, name)
    : path.join(workspaceDir, 'skills', name);
  return path.join(base, 'SKILL.md');
}

/**
 * Apply a proposal. Never throws — validation/guard failures return a
 * `written:false` outcome with a reason. Idempotent per (name, content).
 */
export function applyProposal(proposal: ReviewProposal, ctx: WriterContext): WriteOutcome {
  if (proposal.action === 'none') return { written: false, action: 'none' };

  const queued = ctx.mode === 'propose';

  // Resolve intended action + target, applying priority/dedup for `create`.
  let action: 'create' | 'edit' = proposal.action;
  let name = (proposal.name ?? proposal.targetSkill ?? '').trim();
  let target: ExistingSkill | undefined;

  if (proposal.action === 'edit') {
    name = (proposal.targetSkill ?? proposal.name ?? '').trim();
    target = ctx.existing.find((s) => s.name === name);
    if (!target) return { written: false, action: 'edit', name, reason: 'edit target not found' };
    if (target.origin !== 'auto') {
      return { written: false, action: 'edit', name, reason: 'provenance guard: target is not origin:auto' };
    }
  } else {
    // create — collision + dedup
    const byName = ctx.existing.find((s) => s.name === name);
    if (byName) {
      if (byName.origin !== 'auto') {
        return { written: false, action: 'create', name, reason: 'provenance guard: name collides with non-auto skill' };
      }
      // duplicate of an existing auto skill → downgrade to edit
      action = 'edit';
      target = byName;
    } else {
      // dedup by description against auto skills → downgrade to edit
      const byDesc = ctx.existing.find(
        (s) => s.origin === 'auto' && normalizeDesc(s.description) === normalizeDesc(proposal.desc ?? ''),
      );
      if (byDesc && normalizeDesc(proposal.desc ?? '')) {
        action = 'edit';
        name = byDesc.name;
        target = byDesc;
      }
    }
  }

  const nameError = validateName(name);
  if (nameError) return { written: false, action, name, reason: nameError };

  const description = (proposal.desc ?? target?.description ?? '').trim();
  const body = (proposal.body ?? '').trim();
  if (!description) return { written: false, action, name, reason: 'missing description' };
  if (!body) return { written: false, action, name, reason: 'missing body' };

  // Preserve provenance on edit; stamp fresh on create.
  let createdAt = ctx.now;
  let createdFromSession = ctx.sessionId;
  let pinned = false;
  if (action === 'edit' && target) {
    try {
      const fm = extractFrontmatter(fs.readFileSync(target.filePath, 'utf-8'))?.frontmatter;
      if (fm) {
        if (typeof fm['createdAt'] === 'number') createdAt = fm['createdAt'] as number;
        if (typeof fm['createdFromSession'] === 'string') createdFromSession = fm['createdFromSession'] as string;
        if (fm['pinned'] === true) pinned = true;
      }
    } catch {
      /* keep defaults */
    }
  }

  const skillMd = buildSkillMd({
    name,
    description,
    body,
    origin: 'auto',
    createdFromSession,
    createdAt,
    pinned,
  });

  if (Buffer.byteLength(skillMd, 'utf-8') > MAX_SKILL_SIZE) {
    return { written: false, action, name, reason: `skill exceeds ${MAX_SKILL_SIZE} bytes` };
  }

  try {
    atomicWrite(skillFilePath(ctx.workspaceDir, name, queued), skillMd);
  } catch (err) {
    return { written: false, action, name, reason: `write failed: ${(err as Error).message}` };
  }

  return { written: true, action, name, queued };
}

function normalizeDesc(d: string): string {
  return d.trim().toLowerCase().replace(/\s+/g, ' ');
}
