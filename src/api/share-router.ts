import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import { createApiAuthMiddleware, canAccessAgent } from './auth';
import { isValidAgentId, isValidSessionId } from './router';
import { MediaStore } from '../history/media-store';
import { ApiKey } from '../types';
import {
  ShareStore,
  ShareError,
  ShareLimits,
  detectImageMime,
  shareLimitsFromEnv,
  validateShareFile,
  DEFAULT_SHARE_TTL_SECONDS,
} from '../share/share-store';
import { computeSessionImageCatalog } from '../share/session-image-catalog';

/**
 * Share bridge HTTP surface (#70, plan §10/§11).
 *
 *   Public  : GET|HEAD /shared/:token       — token IS the capability, no auth
 *   Private : POST     /api/v1/shares — mint (API-key auth, agent-scoped)
 *             DELETE   /api/v1/shares/:shareId
 *             POST     /api/v1/image-artifacts
 *             GET      /api/v1/image-catalog   — session image list (#72)
 *
 * Deliberately NOT implemented (§10): any list endpoint (GET /api/v1/shares,
 * GET /shared) — shares are unenumerable by design. /v1/image-catalog is NOT an
 * exception: it enumerates the session's IMAGES (paths / artifact refs), never
 * shares, and never returns a token.
 *
 * Logging rules (§19): log share id / purpose / status / byte count only —
 * never the plaintext token, never an absolute filesystem path.
 */

type AuthedRequest = Request & { apiKey: ApiKey };

const PURPOSE_RE = /^[a-z][a-z0-9_]{0,31}$/;
const MIN_TTL_SECONDS = 10;
const MAX_TTL_SECONDS = 86_400;
const MAX_ARTIFACT_FILES = 10;
const MAX_ARTIFACT_PROMPT_CHARS = 500;
const DEFAULT_PUBLIC_RATE_PER_MIN = 60;

function errStatus(code: string): number {
  switch (code) {
    case 'image_ref_not_found': return 404;
    case 'image_too_large': return 413;
    case 'total_size_exceeded': return 413;
    case 'unsupported_image_type': return 415;
    default: return 400;
  }
}

/** Uniform public 404 — identical body for unknown / expired / revoked /
 *  deleted / forbidden so the response never leaks WHY (§11). */
function publicNotFound(res: Response): void {
  res.status(404).type('text/plain').send('Not Found');
}

export type PublicShareRouterOpts = {
  /** Per-IP GET/HEAD budget per minute (in-handler limiter; Traefik-level
   *  limiting is Step 5 and out of scope here). */
  ratePerMinute?: number;
};

export function createSharesPublicRouter(
  store: ShareStore,
  agentsBaseDir: string,
  opts: PublicShareRouterOpts = {},
): Router {
  const router = Router();
  const envRate = Number(process.env.IMAGE_SHARE_PUBLIC_RATE_PER_MIN);
  const ratePerMinute =
    opts.ratePerMinute ?? (Number.isFinite(envRate) && envRate > 0 ? envRate : DEFAULT_PUBLIC_RATE_PER_MIN);
  const limits = shareLimitsFromEnv();

  // Fixed-window per-IP limiter. This endpoint is unauthenticated and shares
  // the event loop with the chat API, so a cheap 404-flood must be shed here
  // before it reaches the SQLite lookup (§11).
  const rateMap = new Map<string, { count: number; resetAt: number }>();
  // Throttle the lazy expiry sweep: a token miss triggers a full-table DELETE,
  // so an unauthenticated 404-flood must not turn every miss into a table write.
  // Sweep at most once per minute (the rows are only garbage-collected, never
  // served, so a minute of staleness is harmless).
  let lastSweepMs = 0;
  const SWEEP_THROTTLE_MS = 60_000;
  const allow = (ip: string): boolean => {
    const now = Date.now();
    const entry = rateMap.get(ip);
    if (!entry || now >= entry.resetAt) {
      // Opportunistic prune keeps the map bounded without a timer.
      if (rateMap.size > 10_000) {
        for (const [k, v] of rateMap) if (now >= v.resetAt) rateMap.delete(k);
      }
      rateMap.set(ip, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    if (entry.count >= ratePerMinute) return false;
    entry.count++;
    return true;
  };

  // /shared is the path after production Traefik strips /gateway.
  // /gateway/shared is the direct-path alias used by localhost Docker E2E.
  router.all(['/shared/:token', '/gateway/shared/:token'], (req: Request, res: Response) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.status(405).set('Allow', 'GET, HEAD').type('text/plain').send('Method Not Allowed');
      return;
    }
    if (!allow(req.ip ?? 'unknown')) {
      res.status(429).type('text/plain').send('Too Many Requests');
      return;
    }
    const token = req.params.token ?? '';
    const share = store.lookupByToken(token);
    if (!share) {
      const nowMs = Date.now();
      if (nowMs - lastSweepMs >= SWEEP_THROTTLE_MS) {
        lastSweepMs = nowMs;
        store.cleanupExpired(); // throttled lazy expiry sweep (≤1×/min)
      }
      publicNotFound(res);
      return;
    }

    // Re-resolve and revalidate at GET time (§12.9): containment + symlink
    // checks again, then open a file descriptor FIRST and validate through it
    // (fstat regular-file + size + magic) to shrink the TOCTOU window (§12.10).
    let fd: number | undefined;
    try {
      const abs = MediaStore.resolvePath(agentsBaseDir, share.agentId, share.relativePath);
      fd = fs.openSync(abs, 'r');
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > limits.maxFileBytes) throw new Error('invalid file');
      const header = Buffer.alloc(12);
      fs.readSync(fd, header, 0, 12, 0);
      const mime = detectImageMime(header);
      if (!mime) throw new Error('unsupported type');

      res.status(200).set({
        'Content-Type': mime,
        'Content-Length': String(stat.size),
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      });
      if (req.method === 'HEAD') {
        fs.closeSync(fd);
        res.end();
      } else {
        // createReadStream owns the fd from here (autoClose defaults true).
        const stream = fs.createReadStream('', { fd, start: 0 });
        stream.on('error', () => {
          try { res.destroy(); } catch { /* already gone */ }
        });
        stream.pipe(res);
      }
      console.log(`[share] fetch ok share=${share.shareId} purpose=${share.purpose} bytes=${stat.size}`);
    } catch {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* already closed */ }
      }
      // File deleted / replaced by a non-image / traversal — same uniform 404.
      publicNotFound(res);
    }
  });

  return router;
}

export function createSharesPrivateRouter(
  store: ShareStore,
  apiKeys: ApiKey[],
  agentsBaseDir: string,
  publicBaseUrl?: string,
  limitsOverride?: ShareLimits,
): Router {
  const router = Router();
  const auth = createApiAuthMiddleware(apiKeys);
  const limits = limitsOverride ?? shareLimitsFromEnv();
  const defaultTtl = (() => {
    const n = Number(process.env.IMAGE_SHARE_CODEX_TTL_SECONDS);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_SHARE_TTL_SECONDS;
  })();

  /**
   * POST /api/v1/shares — mint one or more shares (§10).
   * Body: { agent_id, session_id, purpose?, ttl_seconds?, refs: [{artifact_id}|{path}] }
   * Response: { items: [{ share_id, token, url?, expires_at }] } — order preserved.
   * `token` is always present (host-agnostic capability); `url` is a convenience
   * built from `gateway.publicUrl` and is omitted when that is unset — callers
   * with their own public base (e.g. LINE) build the URL from `token`.
   */
  router.post('/v1/shares', auth, (req: Request, res: Response) => {
    const apiKey = (req as AuthedRequest).apiKey;
    const body = req.body as {
      agent_id?: unknown;
      session_id?: unknown;
      purpose?: unknown;
      ttl_seconds?: unknown;
      refs?: unknown;
    };
    const agentId = typeof body.agent_id === 'string' ? body.agent_id.trim() : '';
    const sessionId = typeof body.session_id === 'string' ? body.session_id.trim() : '';
    if (!isValidAgentId(agentId) || !isValidSessionId(sessionId)) {
      res.status(400).json({ error: 'agent_id and session_id must be valid identifiers' });
      return;
    }
    if (!canAccessAgent(apiKey, agentId)) {
      res.status(403).json({ error: `API key has no access to agent '${agentId}'` });
      return;
    }
    const purpose = body.purpose === undefined ? 'codex_ref' : (typeof body.purpose === 'string' ? body.purpose : '');
    if (!PURPOSE_RE.test(purpose)) {
      res.status(400).json({ error: 'purpose must match [a-z][a-z0-9_]{0,31}' });
      return;
    }
    let ttlSeconds = defaultTtl;
    if (body.ttl_seconds !== undefined) {
      if (typeof body.ttl_seconds !== 'number' || !Number.isFinite(body.ttl_seconds)) {
        res.status(400).json({ error: 'ttl_seconds must be a number' });
        return;
      }
      ttlSeconds = Math.min(Math.max(Math.floor(body.ttl_seconds), MIN_TTL_SECONDS), MAX_TTL_SECONDS);
    }
    const refs = body.refs;
    if (!Array.isArray(refs) || refs.length === 0) {
      res.status(400).json({ error: 'refs must be a non-empty array' });
      return;
    }
    if (refs.length > limits.maxRefs) {
      res.status(400).json({ error: `too many refs (max ${limits.maxRefs})`, code: 'too_many_refs' });
      return;
    }

    // Resolve + validate every ref BEFORE minting anything, preserving order.
    type Resolved = { dedupeRef: string; relativePath: string; size: number };
    const resolved: Resolved[] = [];
    const seen = new Set<string>();
    let totalBytes = 0;
    for (const raw of refs as unknown[]) {
      if (typeof raw !== 'object' || raw === null) {
        res.status(400).json({ error: 'each ref must be an object with artifact_id or path' });
        return;
      }
      const ref = raw as { artifact_id?: unknown; path?: unknown };
      let dedupeRef: string;
      let candidatePath: string;
      if (typeof ref.artifact_id === 'string' && ref.artifact_id.trim()) {
        const artifact = store.resolveArtifact(agentId, sessionId, ref.artifact_id.trim());
        if (!artifact) {
          res.status(404).json({ error: 'referenced artifact was not found in this agent/session', code: 'image_ref_not_found' });
          return;
        }
        dedupeRef = `artifact:${artifact.artifactId}`;
        candidatePath = artifact.relativePath;
      } else if (typeof ref.path === 'string' && ref.path.trim()) {
        candidatePath = ref.path.trim();
        dedupeRef = ''; // filled after validation with the canonical relative path
      } else {
        res.status(400).json({ error: 'each ref must carry artifact_id or path' });
        return;
      }
      let validated;
      try {
        validated = validateShareFile(agentsBaseDir, agentId, candidatePath, limits.maxFileBytes);
      } catch (err) {
        if (err instanceof ShareError) {
          res.status(errStatus(err.code)).json({ error: err.message, code: err.code });
          return;
        }
        res.status(400).json({ error: 'invalid ref', code: 'invalid_path' });
        return;
      }
      if (!dedupeRef) dedupeRef = `path:${validated.relativePath}`;
      if (seen.has(dedupeRef)) {
        res.status(400).json({ error: 'duplicate ref', code: 'duplicate_ref' });
        return;
      }
      seen.add(dedupeRef);
      totalBytes += validated.size;
      resolved.push({ dedupeRef, relativePath: validated.relativePath, size: validated.size });
    }
    if (totalBytes > limits.maxTotalBytes) {
      res.status(413).json({ error: `total reference size exceeds ${limits.maxTotalBytes} bytes`, code: 'total_size_exceeded' });
      return;
    }

    const items = resolved.map((r) => {
      const mint = store.mintShare({
        agentId,
        sessionId,
        relativePath: r.relativePath,
        dedupeRef: r.dedupeRef,
        purpose,
        ttlSeconds,
      });
      console.log(`[share] mint share=${mint.shareId} purpose=${purpose} deduped=${mint.deduped}`);
      return {
        share_id: mint.shareId,
        token: mint.token,
        ...(publicBaseUrl ? { url: `${publicBaseUrl}/shared/${mint.token}` } : {}),
        expires_at: new Date(mint.expiresAtMs).toISOString(),
      };
    });
    res.status(201).json({ items });
  });

  /**
   * DELETE /api/v1/shares/:shareId — revoke (§10). Only a key with
   * access to the owning agent (or admin) may revoke; anything else is a
   * uniform 404 so share ids are not confirmable cross-tenant.
   */
  router.delete('/v1/shares/:shareId', auth, (req: Request, res: Response) => {
    const apiKey = (req as AuthedRequest).apiKey;
    const shareId = req.params.shareId ?? '';
    const owner = store.getShareOwner(shareId);
    if (!owner || !canAccessAgent(apiKey, owner.agentId)) {
      res.status(404).json({ error: 'share not found' });
      return;
    }
    store.revokeShare(shareId);
    console.log(`[share] revoke share=${shareId} purpose=${owner.purpose}`);
    res.json({ revoked: true });
  });

  /**
   * POST /api/v1/image-artifacts — register generated images as private
   * artifacts (§8). Body: { agent_id, session_id, provider, model, task_id?, prompt?, files: [path] }.
   * Registration never makes a file public — shares are minted separately.
   */
  router.post('/v1/image-artifacts', auth, (req: Request, res: Response) => {
    const apiKey = (req as AuthedRequest).apiKey;
    const body = req.body as {
      agent_id?: unknown;
      session_id?: unknown;
      provider?: unknown;
      model?: unknown;
      task_id?: unknown;
      prompt?: unknown;
      files?: unknown;
    };
    const agentId = typeof body.agent_id === 'string' ? body.agent_id.trim() : '';
    const sessionId = typeof body.session_id === 'string' ? body.session_id.trim() : '';
    if (!isValidAgentId(agentId) || !isValidSessionId(sessionId)) {
      res.status(400).json({ error: 'agent_id and session_id must be valid identifiers' });
      return;
    }
    if (!canAccessAgent(apiKey, agentId)) {
      res.status(403).json({ error: `API key has no access to agent '${agentId}'` });
      return;
    }
    const files = body.files;
    if (!Array.isArray(files) || files.length === 0 || files.some((f) => typeof f !== 'string' || !f.trim())) {
      res.status(400).json({ error: 'files must be a non-empty array of strings' });
      return;
    }
    if (files.length > MAX_ARTIFACT_FILES) {
      res.status(400).json({ error: `too many files (max ${MAX_ARTIFACT_FILES})` });
      return;
    }
    const provider = typeof body.provider === 'string' && body.provider.trim() ? body.provider.trim() : 'unknown';
    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'unknown';
    const taskId = typeof body.task_id === 'string' && body.task_id.trim() ? body.task_id.trim() : undefined;
    // Generation prompt, kept as catalog metadata (`desc`) so a later turn can
    // resolve "the dog picture" style references. Capped — it describes, it is
    // not a transcript.
    const prompt = typeof body.prompt === 'string' && body.prompt.trim()
      ? body.prompt.trim().slice(0, MAX_ARTIFACT_PROMPT_CHARS)
      : undefined;

    const items: Array<{ artifact_id: string; artifact_ref: string; index: number; path: string }> = [];
    for (let index = 0; index < (files as string[]).length; index++) {
      const file = (files as string[])[index]!;
      let validated;
      try {
        validated = validateShareFile(agentsBaseDir, agentId, file, limits.maxFileBytes);
      } catch (err) {
        const code = err instanceof ShareError ? err.code : 'invalid_path';
        res.status(errStatus(code)).json({ error: err instanceof Error ? err.message : 'invalid file', code });
        return;
      }
      const artifactId = store.registerArtifact({
        agentId,
        sessionId,
        relativePath: validated.relativePath,
        provider,
        model,
        taskId,
        imageIndex: index,
        prompt,
      });
      items.push({ artifact_id: artifactId, artifact_ref: `artifact:${artifactId}`, index, path: file });
    }
    console.log(`[share] artifacts registered count=${items.length} provider=${provider}`);
    res.status(201).json({ items });
  });

  /**
   * GET /api/v1/image-catalog?agent_id=...&session_id=... — the deterministic
   * image list of one session, oldest first (#72). Response:
   * { items: [{ index, ref, relative_path, origin, ts, available }] }.
   *
   * Read-only: it mints nothing and returns no token, so "the agent can look up
   * image N" never widens the share surface. Same trust model as the mint
   * endpoint (caller holds a gateway key scoped to the agent).
   */
  router.get('/v1/image-catalog', auth, (req: Request, res: Response) => {
    const apiKey = (req as AuthedRequest).apiKey;
    const agentId = typeof req.query.agent_id === 'string' ? req.query.agent_id.trim() : '';
    const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id.trim() : '';
    if (!isValidAgentId(agentId) || !isValidSessionId(sessionId)) {
      res.status(400).json({ error: 'agent_id and session_id must be valid identifiers' });
      return;
    }
    if (!canAccessAgent(apiKey, agentId)) {
      res.status(403).json({ error: `API key has no access to agent '${agentId}'` });
      return;
    }
    const items = computeSessionImageCatalog({ agentsBaseDir, store, agentId, sessionId });
    res.json({ items });
  });

  return router;
}
