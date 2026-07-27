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

export type ShareItem = { share_id: string; url: string; expires_at: string };

export type ArtifactItem = { artifact_id: string; artifact_ref: string; index: number; path: string };

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
 * The bridge is usable only when the feature flag is on AND the gateway API
 * env (URL/key/agent/session identity) reached this subprocess.
 */
export function shareBridgeEnabled(): boolean {
  return (
    (process.env.IMAGE_SHARE_ENABLED ?? '').toLowerCase() === 'true' &&
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
  method: 'POST' | 'DELETE',
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
  const { status, json } = await callGateway('POST', '/api/v1/image-shares', body);
  if (status !== 201) {
    const code = typeof json.code === 'string' ? json.code : 'share_failed';
    const message = typeof json.error === 'string' ? json.error : `share request failed (HTTP ${status})`;
    throw new ShareClientError(code, message, status);
  }
  const items = json.items;
  if (!Array.isArray(items)) throw new ShareClientError('share_failed', 'invalid share response', status);
  return items as ShareItem[];
}

/** Revoke a share by id. Throws ShareClientError on failure. */
export async function revokeShare(shareId: string): Promise<void> {
  const { status, json } = await callGateway('DELETE', `/api/v1/image-shares/${encodeURIComponent(shareId)}`);
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
  meta: { provider: string; model: string; taskId?: string },
): Promise<ArtifactItem[] | null> {
  try {
    const { status, json } = await callGateway('POST', '/api/v1/image-artifacts', {
      agent_id: process.env.GATEWAY_AGENT_ID,
      session_id: process.env.GATEWAY_SESSION_ID,
      provider: meta.provider,
      model: meta.model,
      ...(meta.taskId ? { task_id: meta.taskId } : {}),
      files,
    });
    if (status !== 201 || !Array.isArray(json.items)) return null;
    return json.items as ArtifactItem[];
  } catch {
    return null;
  }
}
