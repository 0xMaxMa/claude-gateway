import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import { MediaStore } from '../history/media-store';

/**
 * Share bridge — SQLite-backed store for short-lived public image shares
 * and private image artifacts (#70, plan §8/§9).
 *
 * The gateway MAIN process is the only owner of this DB: MCP subprocesses go
 * through the authenticated HTTP API (share-router.ts) and never open
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
/** Artifacts older than this are pruned opportunistically — far beyond any share
 *  TTL (max 24h) and any live session, so removal never breaks an active ref. */
export const ARTIFACT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const ARTIFACT_PRUNE_THROTTLE_MS = 60 * 60 * 1000; // sweep at most once/hour

export type ShareLimits = {
  maxRefs: number;
  maxFileBytes: number;
  maxTotalBytes: number;
};

/**
 * Read a share setting, preferring the neutral `SHARE_*` name and falling back
 * to the legacy `IMAGE_SHARE_*` one (#444). Both names are forwarded to session
 * subprocesses, so an operator who set either keeps working. An empty value
 * counts as unset — `src/session/process.ts` forwards unset vars as `''`, and
 * without this an empty new name would shadow a real legacy one.
 */
export function shareEnv(suffix: string): string | undefined {
  const pick = (v: string | undefined): string | undefined => (v !== undefined && v !== '' ? v : undefined);
  return pick(process.env[`SHARE_${suffix}`]) ?? pick(process.env[`IMAGE_SHARE_${suffix}`]);
}

export function shareLimitsFromEnv(): ShareLimits {
  const num = (v: string | undefined, dflt: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
  };
  return {
    maxRefs: num(shareEnv('MAX_REFS'), DEFAULT_MAX_REFS),
    maxFileBytes: num(shareEnv('MAX_FILE_BYTES'), DEFAULT_MAX_FILE_BYTES),
    maxTotalBytes: num(shareEnv('MAX_TOTAL_BYTES'), DEFAULT_MAX_TOTAL_BYTES),
  };
}

/** Typed error with a stable machine-readable code (used for HTTP mapping). */
export class ShareError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Raster image formats: PNG / JPEG / WebP (§11). GIF/SVG/PDF are NOT images
 *  here — callers that genuinely need "is this an image" (LINE image messages,
 *  provider image-edit refs, the session image catalog) must keep using this
 *  one rather than the wider detectShareMime below. */
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

/**
 * What a share is allowed to carry. Persisted per share row and re-checked at
 * fetch time — it is NOT a cached mime (#444). The file behind a live share can
 * be replaced between mint and fetch, so serving always re-sniffs the magic
 * bytes; this kind only selects WHICH detector runs. That keeps both directions
 * safe: an `image` share whose file became a PDF still 404s, and an `any` share
 * whose file became HTML still 404s.
 */
export type ShareAllowKind = 'image' | 'any';

export const SHARE_ALLOW_KINDS: readonly ShareAllowKind[] = ['image', 'any'];

export function isShareAllowKind(v: unknown): v is ShareAllowKind {
  return typeof v === 'string' && (SHARE_ALLOW_KINDS as readonly string[]).includes(v);
}

/** `%PDF-` — the only non-image format on the share allowlist (#444). */
function isPdf(header: Buffer): boolean {
  return (
    header.length >= 5 &&
    header[0] === 0x25 && header[1] === 0x50 && header[2] === 0x44 && header[3] === 0x46 && header[4] === 0x2d
  );
}

/**
 * The full share allowlist: the three raster image types plus PDF. Deliberately
 * limited to inert binary formats — `text/html`, `image/svg+xml` and
 * `application/octet-stream` are NOT here and must not be added, because the
 * share origin serves them to a browser and they would turn it into an XSS
 * surface (§11).
 */
export function detectShareMime(header: Buffer): string | null {
  return detectImageMime(header) ?? (isPdf(header) ? 'application/pdf' : null);
}

/** Pick the sniffer that matches a share's allow-kind. */
export function mimeDetectorFor(allow: ShareAllowKind): (header: Buffer) => string | null {
  return allow === 'any' ? detectShareMime : detectImageMime;
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
 * are never persisted. Throws ShareError with a stable code.
 *
 * `allow` defaults to 'image' so every existing caller keeps today's behaviour;
 * only a caller that has explicitly opted into documents passes 'any' (#444).
 */
export function validateShareFile(
  agentsBaseDir: string,
  agentId: string,
  ref: string,
  maxFileBytes: number = DEFAULT_MAX_FILE_BYTES,
  allow: ShareAllowKind = 'image',
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
    throw new ShareError('invalid_path', 'path is outside the agent media root');
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved); // realpath already followed links; lstat guards devices/FIFOs
  } catch {
    throw new ShareError('share_ref_not_found', 'referenced file does not exist');
  }
  if (!stat.isFile()) {
    throw new ShareError('invalid_path', 'referenced path is not a regular file');
  }
  if (stat.size > maxFileBytes) {
    throw new ShareError('file_too_large', `file exceeds ${maxFileBytes} bytes`);
  }
  const header = Buffer.alloc(12);
  const fd = fs.openSync(resolved, 'r');
  try {
    fs.readSync(fd, header, 0, 12, 0);
  } finally {
    fs.closeSync(fd);
  }
  const mime = mimeDetectorFor(allow)(header);
  if (!mime) {
    throw new ShareError(
      'unsupported_file_type',
      allow === 'any'
        ? 'only PNG, JPEG, WebP and PDF can be shared'
        : 'only PNG, JPEG and WebP can be shared',
    );
  }
  const relativePath = path.relative(root, resolved);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new ShareError('invalid_path', 'path is outside the agent media root');
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
  /** What this share was minted to carry. Serving re-sniffs the file and uses
   *  this only to pick the detector — never as a cached mime (#444). */
  allowKind: ShareAllowKind;
};

export type ArtifactRow = {
  artifactId: string;
  agentId: string;
  sessionId: string;
  relativePath: string;
  provider: string;
  model: string;
  /** The provider-side task id that produced this artifact, if known — the
   *  key a resume-capable provider needs to continue that generation's
   *  session. Empty for artifacts registered without one (older rows, or
   *  providers with no resume concept). */
  taskId: string;
  /** The prompt used to produce this artifact, if recorded
   *  (handoff-on-model-switch) — deterministic reuse source for continuing an
   *  edit across a model switch where session resume isn't possible. Already
   *  length-capped at registration time (registerArtifact). Empty if none was
   *  recorded. */
  prompt: string;
};

export class ShareStore {
  private readonly db: DatabaseSync;
  /** In-memory idempotent-mint cache: dedupe key → last mint. Plaintext tokens
   *  live here only for MINT_DEDUPE_WINDOW_MS, never on disk (§9/§17.4). */
  private readonly mintCache = new Map<string, MintedShare & { mintedAtMs: number }>();
  /** Last opportunistic artifact-prune timestamp (throttle, see registerArtifact). */
  private lastArtifactPruneMs = 0;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA busy_timeout=5000');
    this.db.exec('PRAGMA foreign_keys=ON');
    // #444: the table was `image_shares` back when the bridge could only carry
    // images. Rename in place — and BEFORE the CREATE TABLE IF NOT EXISTS
    // below, which would otherwise create an empty `file_shares` beside the
    // real data and silently 404 every live share. Shares are ephemeral (TTL
    // <= 24h, swept by cleanupExpired) so nothing durable is at stake, but
    // renaming keeps shares minted before the upgrade resolving after it.
    const hasTable = (name: string): boolean =>
      !!this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
    if (hasTable('image_shares') && !hasTable('file_shares')) {
      this.db.exec('ALTER TABLE image_shares RENAME TO file_shares');
      // RENAME TO carries indexes over under their OLD names, so drop the old
      // one rather than let CREATE INDEX IF NOT EXISTS add a duplicate.
      this.db.exec('DROP INDEX IF EXISTS image_shares_expiry');
      console.log('[share] renamed legacy image_shares table to file_shares');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_shares (
        id            TEXT PRIMARY KEY,
        token_hash    BLOB NOT NULL UNIQUE,
        agent_id      TEXT NOT NULL,
        session_id    TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        purpose       TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        expires_at    INTEGER NOT NULL,
        revoked_at    INTEGER,
        allow_kind    TEXT NOT NULL DEFAULT 'image'
      );
      CREATE INDEX IF NOT EXISTS file_shares_expiry ON file_shares(expires_at);

      CREATE TABLE IF NOT EXISTS image_artifacts (
        id            TEXT PRIMARY KEY,
        agent_id      TEXT NOT NULL,
        session_id    TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        provider      TEXT NOT NULL,
        model         TEXT NOT NULL,
        task_id       TEXT,
        image_index   INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL,
        prompt        TEXT
      );
      CREATE INDEX IF NOT EXISTS image_artifacts_session_created
        ON image_artifacts(agent_id, session_id, created_at DESC);
    `);
    // DBs created before the `prompt` column existed: CREATE TABLE IF NOT
    // EXISTS leaves them untouched, so add the column in place. Additive and
    // nullable — older rows simply have no prompt.
    const cols = this.db.prepare(`PRAGMA table_info(image_artifacts)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'prompt')) {
      this.db.exec('ALTER TABLE image_artifacts ADD COLUMN prompt TEXT');
    }
    // Same story for `allow_kind` (#444): DBs minted before documents were
    // allowed carry image-only shares, and 'image' is exactly their existing
    // behaviour, so the default backfills them correctly.
    const shareCols = this.db.prepare(`PRAGMA table_info(file_shares)`).all() as Array<{ name: string }>;
    if (!shareCols.some((c) => c.name === 'allow_kind')) {
      this.db.exec(`ALTER TABLE file_shares ADD COLUMN allow_kind TEXT NOT NULL DEFAULT 'image'`);
    }
    // `image_shares` surviving THIS far means a downgrade recreated it (the
    // pre-#444 release runs its own CREATE TABLE IF NOT EXISTS) and minted
    // into it, and we have now rolled forward. The rename guard above no
    // longer fires — both tables exist — so without this those shares would
    // 404 until their TTL ran out while the orphan table stayed in the file
    // forever. Fold the rows in (they are image-only by definition: the
    // release that wrote them knew nothing else) and drop the orphan, so the
    // migration is idempotent across a rollback rather than one-shot. Runs
    // after the ALTER above so `allow_kind` is guaranteed to exist.
    if (hasTable('image_shares')) {
      const legacy = this.db.prepare(`SELECT COUNT(*) AS n FROM image_shares`).get() as { n: number };
      const before = this.db.prepare(`SELECT COUNT(*) AS n FROM file_shares`).get() as { n: number };
      this.db.exec(`
        INSERT OR IGNORE INTO file_shares
          (id, token_hash, agent_id, session_id, relative_path, purpose, created_at, expires_at, revoked_at, allow_kind)
        SELECT id, token_hash, agent_id, session_id, relative_path, purpose, created_at, expires_at, revoked_at, 'image'
          FROM image_shares
      `);
      const after = this.db.prepare(`SELECT COUNT(*) AS n FROM file_shares`).get() as { n: number };
      // DROP TABLE takes the table's indexes with it.
      this.db.exec('DROP TABLE image_shares');
      // Say so. Reaching here at all means this deployment was rolled back
      // across #444 and rolled forward again — rare, and worth a line in the
      // log rather than a database that quietly changed shape. `skipped` is
      // non-zero only when OR IGNORE hit the token_hash UNIQUE, i.e. the same
      // token exists in both tables; the file_shares row wins because it is the
      // one this build minted. No token or path is logged (§19).
      const folded = after.n - before.n;
      console.log(
        `[share] migrated legacy image_shares: rows=${legacy.n} folded=${folded} skipped=${legacy.n - folded}`,
      );
    }
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
    prompt?: string;
  }): string {
    const id = `img_${randomBytes(9).toString('base64url')}`;
    this.db.prepare(
      `INSERT INTO image_artifacts (id, agent_id, session_id, relative_path, provider, model, task_id, image_index, created_at, prompt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, a.agentId, a.sessionId, a.relativePath, a.provider, a.model, a.taskId ?? null, a.imageIndex ?? 0, Date.now(), a.prompt ?? null);
    this.pruneOldArtifacts();
    return id;
  }

  /** Opportunistic, throttled retention sweep — delete artifacts older than
   *  ARTIFACT_RETENTION_MS. Best-effort: a failure here must not fail the insert. */
  private pruneOldArtifacts(): void {
    const now = Date.now();
    if (now - this.lastArtifactPruneMs < ARTIFACT_PRUNE_THROTTLE_MS) return;
    this.lastArtifactPruneMs = now;
    try {
      this.db.prepare('DELETE FROM image_artifacts WHERE created_at <= ?').run(now - ARTIFACT_RETENTION_MS);
    } catch {
      /* best-effort */
    }
  }

  /** Resolve an artifact bound to the SAME agent AND session — cross-agent or
   *  cross-session lookups return null (uniform "not found", §8). */
  resolveArtifact(agentId: string, sessionId: string, artifactId: string): ArtifactRow | null {
    const row = this.db.prepare(
      `SELECT id, agent_id, session_id, relative_path, provider, model, task_id, prompt
       FROM image_artifacts WHERE id = ? AND agent_id = ? AND session_id = ?`,
    ).get(artifactId, agentId, sessionId) as
      | {
          id: string;
          agent_id: string;
          session_id: string;
          relative_path: string;
          provider: string;
          model: string;
          task_id: string | null;
          prompt: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      artifactId: row.id,
      agentId: row.agent_id,
      sessionId: row.session_id,
      relativePath: row.relative_path,
      provider: row.provider,
      model: row.model,
      taskId: row.task_id ?? '',
      prompt: row.prompt ?? '',
    };
  }

  /** Newest artifact id registered for (agent, session, relative_path), or null.
   *  Read-only reverse lookup for the session image catalog (#72): a path that
   *  was produced by generate_image gets the stable `artifact:<id>` ref instead
   *  of a raw path. Same agent+session binding as resolveArtifact — a path
   *  registered by another agent/session is invisible here. */
  findArtifactByPath(
    agentId: string,
    sessionId: string,
    relativePath: string,
  ): { id: string; prompt: string | null } | null {
    const row = this.db.prepare(
      `SELECT id, prompt FROM image_artifacts
       WHERE agent_id = ? AND session_id = ? AND relative_path = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(agentId, sessionId, relativePath) as { id: string; prompt: string | null } | undefined;
    return row ? { id: row.id, prompt: row.prompt } : null;
  }

  // ── shares (§9) ───────────────────────────────────────────────────────────

  /**
   * Mint a share. `dedupeRef` is the caller-facing identity of the ref
   * (e.g. "artifact:img_x" or "path:<relative>") — an identical mint for the
   * same (agent, session, ref, purpose, allowKind) within MINT_DEDUPE_WINDOW_MS
   * returns the SAME token (§17.4) so provider-side dedupe keeps working.
   * `allowKind` is part of the key because two mints of the same file under
   * different allow-kinds are different capabilities and must not collapse.
   */
  mintShare(a: {
    agentId: string;
    sessionId: string;
    relativePath: string;
    dedupeRef: string;
    purpose: string;
    ttlSeconds: number;
    allowKind?: ShareAllowKind;
  }): MintedShare {
    const allowKind: ShareAllowKind = a.allowKind ?? 'image';
    const key = [a.agentId, a.sessionId, a.dedupeRef, a.purpose, allowKind].join('\0');
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
      `INSERT INTO file_shares (id, token_hash, agent_id, session_id, relative_path, purpose, created_at, expires_at, allow_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(shareId, tokenHash, a.agentId, a.sessionId, a.relativePath, a.purpose, now, expiresAtMs, allowKind);
    this.mintCache.set(key, { shareId, token, expiresAtMs, deduped: false, mintedAtMs: now });
    this.pruneMintCache(now);
    return { shareId, token, expiresAtMs, deduped: false };
  }

  /** Look up a live (unexpired, unrevoked) share by plaintext token. */
  lookupByToken(token: string): ShareRow | null {
    if (!SHARE_TOKEN_RE.test(token)) return null;
    const tokenHash = createHash('sha256').update(token).digest();
    const row = this.db.prepare(
      `SELECT id, agent_id, session_id, relative_path, purpose, allow_kind
       FROM file_shares
       WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
    ).get(tokenHash, Date.now()) as
      | {
          id: string;
          agent_id: string;
          session_id: string;
          relative_path: string;
          purpose: string;
          allow_kind: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      shareId: row.id,
      agentId: row.agent_id,
      sessionId: row.session_id,
      relativePath: row.relative_path,
      purpose: row.purpose,
      // Anything unrecognised (or a legacy NULL) falls back to the strictest
      // kind — an unknown value must never widen what a share can serve.
      allowKind: isShareAllowKind(row.allow_kind) ? row.allow_kind : 'image',
    };
  }

  getShareOwner(shareId: string): { agentId: string; sessionId: string; purpose: string } | null {
    const row = this.db.prepare(
      `SELECT agent_id, session_id, purpose FROM file_shares WHERE id = ? AND revoked_at IS NULL`,
    ).get(shareId) as { agent_id: string; session_id: string; purpose: string } | undefined;
    return row ? { agentId: row.agent_id, sessionId: row.session_id, purpose: row.purpose } : null;
  }

  /** Revoke a share by id. Also evicts any idempotency-cache entry pointing at
   *  it so a post-revoke mint issues a FRESH token. Returns false when unknown. */
  revokeShare(shareId: string): boolean {
    const res = this.db.prepare(
      `UPDATE file_shares SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
    ).run(Date.now(), shareId);
    for (const [key, entry] of this.mintCache) {
      if (entry.shareId === shareId) this.mintCache.delete(key);
    }
    return Number(res.changes) > 0;
  }

  /** Lazy cleanup — delete expired rows. Safe to call opportunistically. */
  cleanupExpired(): void {
    try {
      this.db.prepare(`DELETE FROM file_shares WHERE expires_at <= ?`).run(Date.now());
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
