/**
 * Image share bridge client (#70) — the ONLY way MCP subprocesses touch the
 * share/artifact store. They call the authenticated local Gateway HTTP API
 * (GATEWAY_API_URL + GATEWAY_API_KEY, both already injected into the session
 * subprocess env) and NEVER open the SQLite DB themselves (plan §9/§10).
 *
 * Self-contained on purpose: mcp/** ships as source without src/**, so this
 * module must not import from src/ (see tests/unit/mcp-no-src-imports.test.ts).
 */

const REQUEST_TIMEOUT_MS = 15_000;

export type ShareRef = { artifact_id?: string; path?: string };

export type ShareItem = { share_id: string; token: string; url?: string; expires_at: string };

export type ArtifactItem = { artifact_id: string; artifact_ref: string; index: number; path: string };

/**
 * One entry of the session image catalog (#72). `index` is 1-based and stable —
 * it is the order of FIRST appearance of that file in the session, so "image 1"
 * / "the first image" maps to index 1 deterministically. `ref` is what to feed
 * back into generate_image's image/images argument.
 */
export type CatalogItem = {
  index: number;
  ref: string;
  relative_path: string;
  origin: string;
  ts: number;
  available: boolean;
  /** What the image is: the generation prompt (origin=generated) or the user
   *  text that accompanied the upload. Absent when neither exists. */
  desc?: string;
};

/** Error carrying the gateway's stable machine-readable code (e.g. image_ref_not_found). */
export class ShareClientError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * The bridge client is usable when the gateway API identity reached this
 * subprocess. gateway.publicUrl is the sole server-side enable switch: when it
 * is absent the private mint endpoint is not mounted and calls fail closed.
 */
export function shareBridgeEnabled(): boolean {
  return (
    !!process.env.GATEWAY_API_URL &&
    !!process.env.GATEWAY_API_KEY &&
    !!process.env.GATEWAY_AGENT_ID &&
    !!process.env.GATEWAY_SESSION_ID
  );
}

function apiBase(): string {
  return (process.env.GATEWAY_API_URL ?? '').replace(/\/+$/, '');
}

async function callGateway(
  method: 'GET' | 'POST' | 'DELETE',
  pathname: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${apiBase()}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GATEWAY_API_KEY}`,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text().catch(() => '');
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json };
}

/** Mint short-lived share URLs for local/artifact refs — order preserved. */
export async function createShares(
  refs: ShareRef[],
  opts: { purpose?: string; ttlSeconds?: number } = {},
): Promise<ShareItem[]> {
  const body: Record<string, unknown> = {
    agent_id: process.env.GATEWAY_AGENT_ID,
    session_id: process.env.GATEWAY_SESSION_ID,
    purpose: opts.purpose ?? 'codex_ref',
    refs,
  };
  if (opts.ttlSeconds !== undefined) body.ttl_seconds = opts.ttlSeconds;
  const { status, json } = await callGateway('POST', '/api/v1/shares', body);
  if (status !== 201) {
    const code = typeof json.code === 'string' ? json.code : 'share_failed';
    const message = typeof json.error === 'string' ? json.error : `share request failed (HTTP ${status})`;
    throw new ShareClientError(code, message, status);
  }
  const items = json.items;
  if (!Array.isArray(items)) throw new ShareClientError('share_failed', 'invalid share response', status);
  return items as ShareItem[];
}

/**
 * Read the ground-truth catalog of every image in this session (#72), numbered
 * by first appearance. Read-only: no token is minted and nothing is persisted.
 * Callers must check shareBridgeEnabled() first (same contract as createShares).
 */
export async function listSessionImages(): Promise<CatalogItem[]> {
  const query =
    `agent_id=${encodeURIComponent(process.env.GATEWAY_AGENT_ID ?? '')}` +
    `&session_id=${encodeURIComponent(process.env.GATEWAY_SESSION_ID ?? '')}`;
  const { status, json } = await callGateway('GET', `/api/v1/image-catalog?${query}`);
  if (status !== 200) {
    const { code, message } = extractError(json, `image catalog request failed (HTTP ${status})`, 'catalog_failed');
    throw new ShareClientError(code, message, status);
  }
  const items = json.items;
  if (!Array.isArray(items)) throw new ShareClientError('catalog_failed', 'invalid catalog response', status);
  return items as CatalogItem[];
}

/**
 * Pull a { code, message } out of a gateway error body. The private routes are
 * not uniform: some return { error: "text", code: "x" } (share mint) and some
 * return { error: { code, message } } (image service style), so accept both and
 * fall back to the supplied defaults.
 */
function extractError(
  json: Record<string, unknown>,
  fallbackMessage: string,
  fallbackCode: string,
): { code: string; message: string } {
  let code = typeof json.code === 'string' ? json.code : '';
  let message = typeof json.error === 'string' ? json.error : '';
  const err = json.error;
  if (err && typeof err === 'object') {
    const nested = err as { code?: unknown; message?: unknown };
    if (!code && typeof nested.code === 'string') code = nested.code;
    if (!message && typeof nested.message === 'string') message = nested.message;
  }
  return { code: code || fallbackCode, message: message || fallbackMessage };
}

/** Revoke a share by id. Throws ShareClientError on failure. */
export async function revokeShare(shareId: string): Promise<void> {
  const { status, json } = await callGateway('DELETE', `/api/v1/shares/${encodeURIComponent(shareId)}`);
  if (status !== 200) {
    const message = typeof json.error === 'string' ? json.error : `revoke failed (HTTP ${status})`;
    throw new ShareClientError('revoke_failed', message, status);
  }
}

/** Best-effort revoke of freshly minted shares (used when submit fails, §18). */
export async function revokeSharesBestEffort(shareIds: string[]): Promise<void> {
  for (const id of shareIds) {
    try {
      await revokeShare(id);
    } catch {
      /* best-effort — TTL still bounds exposure */
    }
  }
}

/**
 * Register generated image files as private artifacts (§8). Best-effort: on
 * any failure returns null so image delivery itself never breaks.
 */
export async function registerArtifacts(
  files: string[],
  meta: { provider: string; model: string; taskId?: string; prompt?: string },
): Promise<ArtifactItem[] | null> {
  try {
    const { status, json } = await callGateway('POST', '/api/v1/image-artifacts', {
      agent_id: process.env.GATEWAY_AGENT_ID,
      session_id: process.env.GATEWAY_SESSION_ID,
      provider: meta.provider,
      model: meta.model,
      ...(meta.taskId ? { task_id: meta.taskId } : {}),
      ...(meta.prompt ? { prompt: meta.prompt } : {}),
      files,
    });
    if (status !== 201 || !Array.isArray(json.items)) return null;
    return json.items as ArtifactItem[];
  } catch {
    return null;
  }
}
