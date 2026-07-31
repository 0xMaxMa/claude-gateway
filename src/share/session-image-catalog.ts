import * as fs from 'fs';
import { HistoryDB } from '../history/db';
import { MediaStore } from '../history/media-store';
import { ImageShareStore } from './image-share-store';

/**
 * Session image catalog (#72) — the single deterministic answer to
 * "which image is image N in this chat?".
 *
 * The agent must never count images from its own transcript: after a context
 * compaction or a resumed session that count silently drifts, and the number
 * the user sees has no shared source with the number the agent quotes. This
 * module derives the list from data that is already persisted and append-only
 * (message media_files), so every consumer that calls it agrees by construction.
 *
 * Computed fresh on every call — no new table, no reconciliation job. Ordinals
 * are stable because history only ever grows; the one case that renumbers is
 * retention pruning, which deletes the files too (they were unreferenceable
 * anyway) and renumbers every consumer at once.
 */

/** Phase-1 catalog scope: raster images the share/reference path can carry. */
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/i;

export type SessionImageCatalogItem = {
  /** 1-based ordinal by FIRST appearance — the number the agent and UI share. */
  index: number;
  /** What to hand back to generate_image: `artifact:<id>` when known, else the path. */
  ref: string;
  relative_path: string;
  origin: 'upload' | 'generated';
  ts: number;
  available: boolean;
};

/**
 * History stores media as `media/<chat>/<file>` while image_artifacts (and
 * validateShareFile) store the media-ROOT-relative `<chat>/<file>`. Normalise to
 * the root-relative form so the artifact join can match, and so the same file
 * recorded in either form dedupes to ONE ordinal. MediaStore.resolvePath accepts
 * both, so the emitted path stays usable as a ref.
 */
function toMediaRootRelative(p: string): string {
  return p.startsWith('media/') ? p.slice(6) : p;
}

/** available = the bytes are still on disk. A path that cannot even be resolved
 *  (traversal, escaped symlink) is not addressable, so it is unavailable too. */
function isOnDisk(agentsBaseDir: string, agentId: string, relativePath: string): boolean {
  try {
    return fs.existsSync(MediaStore.resolvePath(agentsBaseDir, agentId, relativePath));
  } catch {
    return false;
  }
}

export function computeSessionImageCatalog(opts: {
  agentsBaseDir: string;
  store: ImageShareStore;
  agentId: string;
  sessionId: string;
}): SessionImageCatalogItem[] {
  const { agentsBaseDir, store, agentId, sessionId } = opts;
  const rows = HistoryDB.forAgent(agentsBaseDir, agentId).listSessionMedia(sessionId);

  const items: SessionImageCatalogItem[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    // Anything the agent produced is a generation; everything else (user turn,
    // system note) is an upload from the caller's side.
    const origin = row.role === 'assistant' ? 'generated' : 'upload';
    for (const raw of row.mediaFiles) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const relativePath = toMediaRootRelative(raw.trim());
      if (!IMAGE_EXT_RE.test(relativePath)) continue;
      // First appearance owns the ordinal forever — re-sending the same file
      // later must not create a second entry or shift the numbers after it.
      if (seen.has(relativePath)) continue;
      seen.add(relativePath);
      const artifactId = store.findArtifactByPath(agentId, sessionId, relativePath);
      items.push({
        index: items.length + 1,
        ref: artifactId ? `artifact:${artifactId}` : relativePath,
        relative_path: relativePath,
        origin,
        ts: row.ts,
        // A missing file STAYS listed (available:false) so the ordinals of the
        // images after it do not shift under the agent mid-conversation.
        available: isOnDisk(agentsBaseDir, agentId, relativePath),
      });
    }
  }
  return items;
}
