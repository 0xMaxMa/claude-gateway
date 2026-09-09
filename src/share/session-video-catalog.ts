import * as fs from 'fs';
import { HistoryDB } from '../history/db';
import { MediaStore } from '../history/media-store';

/**
 * Session VIDEO catalog — the deterministic list of every video clip in ONE
 * chat session, oldest first. The direct analogue of session-image-catalog (#72)
 * for the Media panel's video gallery: derived fresh on every call from the same
 * append-only message media_files, so the panel shows exactly the clips the
 * session produced without a new table or a reconciliation job.
 *
 * Deliberately SEPARATE from the image catalog: the image catalog also backs the
 * agent's `generate_image list_refs` / "Image N" reference resolution, and a video
 * must never leak into that surface (it is not a valid image reference). Keeping
 * videos in their own endpoint means image ordinals are untouched.
 */

/**
 * Clip containers the web renders with <video>. MUST stay byte-identical to the
 * web's AGENT_VIDEO_URL_RE (getpod apps/web: assistant.tsx + use-modal-chat.ts) —
 * they live in separate repos, so there is no shared source to enforce it. A
 * mismatch silently drops a clip the web can play (catalog too narrow) or lists
 * one it cannot render (catalog too wide). Generated clips are always .mp4, so
 * this only bites uploaded containers.
 */
const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v)$/i;

export type SessionVideoCatalogItem = {
  /** 1-based ordinal by FIRST appearance — stable for the life of the session. */
  index: number;
  /** Media-ROOT-relative path ("<chatId>/<file>") — the web builds the media URL from this. */
  relative_path: string;
  origin: 'upload' | 'generated';
  ts: number;
  /** False when the bytes are gone from disk (the ordinal still holds its slot). */
  available: boolean;
  /** What the clip IS: the accompanying message text, so a content reference reads
   *  without conversation memory. Omitted when there is no meaningful text. */
  desc?: string;
};

/** Cap catalog descriptions — they describe, they are not a transcript. */
const MAX_DESC_CHARS = 200;

/** Channel receivers persist bare placeholders ("(video)") for captionless media
 *  — those describe nothing, so they don't become a desc. */
const PLACEHOLDER_CONTENT_RE = /^\((?:photo|image|video|file|sticker|audio|voice)\)$/i;

function toDesc(text: string | null | undefined): string | undefined {
  const t = (text ?? '').trim();
  if (!t || PLACEHOLDER_CONTENT_RE.test(t)) return undefined;
  return t.length > MAX_DESC_CHARS ? `${t.slice(0, MAX_DESC_CHARS)}…` : t;
}

/** History stores media as `media/<chat>/<file>`; normalise to the media-ROOT-
 *  relative `<chat>/<file>` so the same file recorded either way dedupes to one
 *  ordinal. MediaStore.resolvePath accepts both, so the emitted path stays usable. */
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

export function computeSessionVideoCatalog(opts: {
  agentsBaseDir: string;
  agentId: string;
  sessionId: string;
}): SessionVideoCatalogItem[] {
  const { agentsBaseDir, agentId, sessionId } = opts;
  const rows = HistoryDB.forAgent(agentsBaseDir, agentId).listSessionMedia(sessionId);

  const items: SessionVideoCatalogItem[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    // Anything the agent produced is a generation; everything else is an upload.
    const origin = row.role === 'assistant' ? 'generated' : 'upload';
    for (const raw of row.mediaFiles) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const relativePath = toMediaRootRelative(raw.trim());
      if (!VIDEO_EXT_RE.test(relativePath)) continue;
      // First appearance owns the ordinal forever.
      if (seen.has(relativePath)) continue;
      seen.add(relativePath);
      const desc = toDesc(row.content);
      items.push({
        index: items.length + 1,
        relative_path: relativePath,
        origin,
        ts: row.ts,
        available: isOnDisk(agentsBaseDir, agentId, relativePath),
        ...(desc ? { desc } : {}),
      });
    }
  }
  return items;
}
