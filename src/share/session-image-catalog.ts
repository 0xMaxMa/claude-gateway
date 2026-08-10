import * as fs from 'fs';
import { HistoryDB } from '../history/db';
import { MediaStore } from '../history/media-store';
import { detectImageMime, ShareStore } from './share-store';

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

/** Legacy uploads whose original name had no extension were stored as .bin
 *  (clipboard pastes, sanitized non-ASCII filenames). Their extension says
 *  nothing, so ask the bytes: read just enough header to run the same magic-
 *  bytes sniff the share layer validates with. Anything unreadable is not an
 *  image for catalog purposes. */
function binFileIsImage(agentsBaseDir: string, agentId: string, relativePath: string): boolean {
  try {
    const abs = MediaStore.resolvePath(agentsBaseDir, agentId, relativePath);
    const fd = fs.openSync(abs, 'r');
    try {
      const header = Buffer.alloc(12);
      const read = fs.readSync(fd, header, 0, 12, 0);
      return detectImageMime(header.subarray(0, read)) !== null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

export type SessionImageCatalogItem = {
  /** 1-based ordinal by FIRST appearance — the number the agent and UI share. */
  index: number;
  /** What to hand back to generate_image: `artifact:<id>` when known, else the path. */
  ref: string;
  relative_path: string;
  origin: 'upload' | 'generated';
  ts: number;
  available: boolean;
  /** What the image IS, so content references ("the dog picture") resolve
   *  without conversation memory: the generation prompt for generated images,
   *  the accompanying user text for uploads. Omitted when neither exists. */
  desc?: string;
};

/** Cap catalog descriptions — they describe, they are not a transcript. */
const MAX_DESC_CHARS = 200;

/** Channel receivers persist bare placeholders ("(photo)") for captionless
 *  media — those describe nothing, so they don't become a desc. */
const PLACEHOLDER_CONTENT_RE = /^\((?:photo|image|video|file|sticker|audio|voice)\)$/i;

function toDesc(text: string | null | undefined): string | undefined {
  const t = (text ?? '').trim();
  if (!t || PLACEHOLDER_CONTENT_RE.test(t)) return undefined;
  return t.length > MAX_DESC_CHARS ? `${t.slice(0, MAX_DESC_CHARS)}…` : t;
}

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
  store: ShareStore;
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
      if (
        !IMAGE_EXT_RE.test(relativePath) &&
        !(/\.bin$/i.test(relativePath) && binFileIsImage(agentsBaseDir, agentId, relativePath))
      )
        continue;
      // First appearance owns the ordinal forever — re-sending the same file
      // later must not create a second entry or shift the numbers after it.
      if (seen.has(relativePath)) continue;
      seen.add(relativePath);
      const artifact = store.findArtifactByPath(agentId, sessionId, relativePath);
      // Generated → the generation prompt (persisted on the artifact); upload →
      // whatever the user said in the message that carried the file.
      const desc = origin === 'generated' ? toDesc(artifact?.prompt) : toDesc(row.content);
      items.push({
        index: items.length + 1,
        ref: artifact ? `artifact:${artifact.id}` : relativePath,
        relative_path: relativePath,
        origin,
        ts: row.ts,
        // A missing file STAYS listed (available:false) so the ordinals of the
        // images after it do not shift under the agent mid-conversation.
        available: isOnDisk(agentsBaseDir, agentId, relativePath),
        ...(desc ? { desc } : {}),
      });
    }
  }
  return items;
}
