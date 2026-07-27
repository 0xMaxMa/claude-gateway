import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import { MediaStore } from '../history/media-store';

/**
 * Image share bridge — SQLite-backed store for short-lived public image shares
 * and private image artifacts (#70, plan §8/§9).
 *
 * The gateway MAIN process is the only owner of this DB: MCP subprocesses go
 * through the authenticated HTTP API (image-share-router.ts) and never open
 * SQLite themselves. Tokens are bearer capabilities: 24 random bytes,
 * base64url, and ONLY the SHA-256 hash is persisted — the plaintext token
 * exists in the mint response (and a short-lived in-memory dedupe cache) only.
 */

/** randomBytes(24) → base64url without padding = 32 chars. */
export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

/** Idempotent-mint window (§17.4): a re-mint for the same (agent, session,
 *  ref, purpose) within this window returns the SAME token/URL so the
 *  provider's duplicate-submit guard (which hashes the image URLs) still
 *  dedupes agent retries instead of double-billing. */
export const MINT_DEDUPE_WINDOW_MS = 60_000;

export const DEFAULT_SHARE_TTL_SECONDS = 1800; // 30 min (§3.15)
export const DEFAULT_MAX_REFS = 5;
export const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MiB
export const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MiB

export type ShareLimits = {
  maxRefs: number;
  maxFileBytes: number;
  maxTotalBytes: number;
};

export function shareLimitsFromEnv(): ShareLimits {
  const num = (v: string | undefined, dflt: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
  };
  return {
    maxRefs: num(process.env.IMAGE_SHARE_MAX_REFS, DEFAULT_MAX_REFS),
    maxFileBytes: num(process.env.IMAGE_SHARE_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES),
    maxTotalBytes: num(process.env.IMAGE_SHARE_MAX_TOTAL_BYTES, DEFAULT_MAX_TOTAL_BYTES),
  };
}

/** Typed error with a stable machine-readable code (used for HTTP mapping). */
export class ImageShareError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Phase-1 formats: PNG / JPEG / WebP only (§11). GIF/SVG/PDF are rejected. */
export function detectImageMime(header: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'image/jpeg';
  if (header.length >= 8 && header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47) return 'image/png';
  if (
    header.length >= 12 &&
    header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46 &&
    header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50
  ) return 'image/webp';
  return null;
}

export type ValidatedShareFile = {
  /** Path relative to the agent's media root — the ONLY path form persisted (§12.8). */
  relativePath: string;
  size: number;
  mime: string;
};

/**
 * Validate a local ref (absolute or media-relative path) for sharing (§12):
 * canonicalize, require containment in the agent's media root, reject symlink
 * escapes, require a regular file, validate magic bytes and the per-file cap.
 * Returns only the media-root-relative path — client-supplied absolute paths
 * are never persisted. Throws ImageShareError with a stable code.
 */
export function validateShareFile(
  agentsBaseDir: string,
  agentId: string,
  ref: string,
  maxFileBytes: number = DEFAULT_MAX_FILE_BYTES,
): ValidatedShareFile {
  const root = MediaStore.agentMediaRoot(agentsBaseDir, agentId);
  let resolved: string;
  try {
    if (path.isAbsolute(ref)) {
      // Absolute input (e.g. the path generate_image returned): containment +
      // symlink checks mirror MediaStore.resolvePath.
      const abs = path.resolve(ref);
      if (!abs.startsWith(root + path.sep)) throw new Error('outside media root');
      resolved = fs.existsSync(abs) ? fs.realpathSync(abs) : abs;
      if (!resolved.startsWith(root + path.sep)) throw new Error('outside media root');
    } else {
      resolved = MediaStore.resolvePath(agentsBaseDir, agentId, ref);
    }
  } catch {
    throw new ImageShareError('invalid_path', 'path is outside the agent media root');
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved); // realpath already followed links; lstat guards devices/FIFOs
  } catch {
    throw new ImageShareError('image_ref_not_found', 'referenced image file does not exist');
  }
  if (!stat.isFile()) {
    throw new ImageShareError('invalid_path', 'referenced path is not a regular file');
  }
  if (stat.size > maxFileBytes) {
    throw new ImageShareError('image_too_large', `image exceeds ${maxFileBytes} bytes`);
  }
  const header = Buffer.alloc(12);
  const fd = fs.openSync(resolved, 'r');
  try {
    fs.readSync(fd, header, 0, 12, 0);
  } finally {
    fs.closeSync(fd);
  }
  const mime = detectImageMime(header);
  if (!mime) {
    throw new ImageShareError('unsupported_image_type', 'only PNG, JPEG and WebP can be shared');
  }
  const relativePath = path.relative(root, resolved);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new ImageShareError('invalid_path', 'path is outside the agent media root');
  }
  return { relativePath, size: stat.size, mime };
}

export type MintedShare = {
  shareId: string;
  /** Plaintext token — returned to the caller, NEVER persisted or logged. */
  token: string;
  expiresAtMs: number;
  /** true when this mint was served from the idempotency window (§17.4). */
  deduped: boolean;
};

export type ShareRow = {
  shareId: string;
  agentId: string;
  sessionId: string;
  relativePath: string;
  purpose: string;
};

export type ArtifactRow = {
  artifactId: string;
  agentId: string;
  sessionId: string;
  relativePath: string;
  provider: string;
  model: string;
};

export class ImageShareStore {
  private readonly db: DatabaseSync;
  /** In-memory idempotent-mint cache: dedupe key → last mint. Plaintext tokens
   *  live here only for MINT_DEDUPE_WINDOW_MS, never on disk (§9/§17.4). */
  private readonly mintCache = new Map<string, MintedShare & { mintedAtMs: number }>();

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA busy_timeout=5000');
    this.db.exec('PRAGMA foreign_keys=ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS image_shares (
        id            TEXT PRIMARY KEY,
        token_hash    BLOB NOT NULL UNIQUE,
        agent_id      TEXT NOT NULL,
        session_id    TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        purpose       TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        expires_at    INTEGER NOT NULL,
        revoked_at    INTEGER
      );
      CREATE INDEX IF NOT EXISTS image_shares_expiry ON image_shares(expires_at);

      CREATE TABLE IF NOT EXISTS image_artifacts (
        id            TEXT PRIMARY KEY,
        agent_id      TEXT NOT NULL,
        session_id    TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        provider      TEXT NOT NULL,
        model         TEXT NOT NULL,
        task_id       TEXT,
        image_index   INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS image_artifacts_session_created
        ON image_artifacts(agent_id, session_id, created_at DESC);
    `);
  }

  // ── artifacts (§8) ────────────────────────────────────────────────────────

  registerArtifact(a: {
    agentId: string;
    sessionId: string;
    relativePath: string;
    provider: string;
    model: string;
    taskId?: string;
    imageIndex?: number;
  }): string {
    const id = `img_${randomBytes(9).toString('base64url')}`;
    this.db.prepare(
      `INSERT INTO image_artifacts (id, agent_id, session_id, relative_path, provider, model, task_id, image_index, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, a.agentId, a.sessionId, a.relativePath, a.provider, a.model, a.taskId ?? null, a.imageIndex ?? 0, Date.now());
    return id;
  }

  /** Resolve an artifact bound to the SAME agent AND session — cross-agent or
   *  cross-session lookups return null (uniform "not found", §8). */
  resolveArtifact(agentId: string, sessionId: string, artifactId: string): ArtifactRow | null {
    const row = this.db.prepare(
      `SELECT id, agent_id, session_id, relative_path, provider, model
       FROM image_artifacts WHERE id = ? AND agent_id = ? AND session_id = ?`,
    ).get(artifactId, agentId, sessionId) as
      | { id: string; agent_id: string; session_id: string; relative_path: string; provider: string; model: string }
      | undefined;
    if (!row) return null;
    return {
      artifactId: row.id,
      agentId: row.agent_id,
      sessionId: row.session_id,
      relativePath: row.relative_path,
      provider: row.provider,
      model: row.model,
    };
  }

  // ── shares (§9) ───────────────────────────────────────────────────────────

  /**
   * Mint a share. `dedupeRef` is the caller-facing identity of the ref
   * (e.g. "artifact:img_x" or "path:<relative>") — an identical mint for the
   * same (agent, session, ref, purpose) within MINT_DEDUPE_WINDOW_MS returns
   * the SAME token (§17.4) so provider-side dedupe keeps working.
   */
  mintShare(a: {
    agentId: string;
    sessionId: string;
    relativePath: string;
    dedupeRef: string;
    purpose: string;
    ttlSeconds: number;
  }): MintedShare {
    const key = [a.agentId, a.sessionId, a.dedupeRef, a.purpose].join(' ');
    const now = Date.now();
    const cached = this.mintCache.get(key);
    if (cached && now - cached.mintedAtMs < MINT_DEDUPE_WINDOW_MS && cached.expiresAtMs > now) {
      return { shareId: cached.shareId, token: cached.token, expiresAtMs: cached.expiresAtMs, deduped: true };
    }
    const token = randomBytes(24).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest();
    const shareId = `shr_${randomBytes(9).toString('base64url')}`;
    const expiresAtMs = now + a.ttlSeconds * 1000;
    this.db.prepare(
      `INSERT INTO image_shares (id, token_hash, agent_id, session_id, relative_path, purpose, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(shareId, tokenHash, a.agentId, a.sessionId, a.relativePath, a.purpose, now, expiresAtMs);
    this.mintCache.set(key, { shareId, token, expiresAtMs, deduped: false, mintedAtMs: now });
    this.pruneMintCache(now);
    return { shareId, token, expiresAtMs, deduped: false };
  }

  /** Look up a live (unexpired, unrevoked) share by plaintext token. */
  lookupByToken(token: string): ShareRow | null {
    if (!SHARE_TOKEN_RE.test(token)) return null;
    const tokenHash = createHash('sha256').update(token).digest();
    const row = this.db.prepare(
      `SELECT id, agent_id, session_id, relative_path, purpose
       FROM image_shares
       WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
    ).get(tokenHash, Date.now()) as
      | { id: string; agent_id: string; session_id: string; relative_path: string; purpose: string }
      | undefined;
    if (!row) return null;
    return {
      shareId: row.id,
      agentId: row.agent_id,
      sessionId: row.session_id,
      relativePath: row.relative_path,
      purpose: row.purpose,
    };
  }

  getShareOwner(shareId: string): { agentId: string; sessionId: string; purpose: string } | null {
    const row = this.db.prepare(
      `SELECT agent_id, session_id, purpose FROM image_shares WHERE id = ? AND revoked_at IS NULL`,
    ).get(shareId) as { agent_id: string; session_id: string; purpose: string } | undefined;
    return row ? { agentId: row.agent_id, sessionId: row.session_id, purpose: row.purpose } : null;
  }

  /** Revoke a share by id. Also evicts any idempotency-cache entry pointing at
   *  it so a post-revoke mint issues a FRESH token. Returns false when unknown. */
  revokeShare(shareId: string): boolean {
    const res = this.db.prepare(
      `UPDATE image_shares SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
    ).run(Date.now(), shareId);
    for (const [key, entry] of this.mintCache) {
      if (entry.shareId === shareId) this.mintCache.delete(key);
    }
    return Number(res.changes) > 0;
  }

  /** Lazy cleanup — delete expired rows. Safe to call opportunistically. */
  cleanupExpired(): void {
    try {
      this.db.prepare(`DELETE FROM image_shares WHERE expires_at <= ?`).run(Date.now());
    } catch {
      /* best-effort */
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  private pruneMintCache(now: number): void {
    for (const [key, entry] of this.mintCache) {
      if (now - entry.mintedAtMs >= MINT_DEDUPE_WINDOW_MS || entry.expiresAtMs <= now) {
        this.mintCache.delete(key);
      }
    }
  }
}
