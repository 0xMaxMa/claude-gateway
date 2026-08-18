import { createHash } from 'crypto';
import { writeSharedNote } from './shared-writer';
import { resolveSharedConfig } from './config';
import type { KnowledgeSharedConfig } from './types';

/**
 * Build the per-agent→shared promotion function used after the dreaming applier
 * writes an `add` to local memory (K3↔K4). Returns `undefined` when the shared
 * KB is disabled or in `propose` (dry-run) mode — callers then skip promotion.
 *
 * A durable add is written to the shared vault under a **content-hashed**
 * filename so two proposals whose reasons slug to the same name (or a recurring
 * nightly reason) can't silently overwrite each other, and identical content
 * maps to the same file (idempotent). Extracted here so both the nightly
 * auto-applier (src/index.ts) and the manual dashboard accept endpoint share one
 * implementation.
 */
export function makeSharedPromoter(
  agentId: string,
  agentCfg: KnowledgeSharedConfig | undefined,
  globalCfg: KnowledgeSharedConfig | undefined,
): ((p: { reason: string; content?: string }) => void) | undefined {
  const sharedCfg = resolveSharedConfig(agentCfg, globalCfg);
  if (!sharedCfg.enabled || sharedCfg.mode !== 'auto') return undefined;
  return (p: { reason: string; content?: string }) => {
    const content = p.content ?? '';
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 8);
    writeSharedNote(sharedCfg, `${agentId}-${p.reason}-${hash}`, content);
  };
}
