/**
 * Classify the trust/origin of an indexed file by its workspace-relative path.
 *
 * Mirrors openclaw memory-core `resolveMemoryPathClassification`, adapted to our
 * layout. FAIL-CLOSED: anything not explicitly recognized as agent-authored or
 * system-generated is `untrusted` — so later phases (promotion, shared KB) can
 * never auto-promote content whose provenance we could not vouch for.
 *
 *   - `DREAMS.md`, `memory/dreaming/*`, `.dreaming/*`   → system (machine-generated)
 *   - `MEMORY.md`, `USER.md`, `memory/*.md`             → agent  (self-authored)
 *   - everything else (imports, unknown)                → untrusted
 */

import type { OriginClass } from './types';

/** Normalize a path to forward-slash, no leading "./". */
function toPosix(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function classifyOrigin(relPath: string): OriginClass {
  const p = toPosix(relPath).toLowerCase();

  // System: dreaming outputs and the dream diary are machine-generated.
  if (
    p === 'dreams.md' ||
    p.startsWith('memory/dreaming/') ||
    p.startsWith('.dreaming/') ||
    p.startsWith('memory/.dreams/')
  ) {
    return 'system';
  }

  // Agent: the self-authored memory core + atomic notes under memory/.
  if (p === 'memory.md' || p === 'user.md') return 'agent';
  if (p.startsWith('memory/') && p.endsWith('.md')) return 'agent';

  // Fail-closed for anything else.
  return 'untrusted';
}
