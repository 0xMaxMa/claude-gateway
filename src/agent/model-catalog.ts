/**
 * Live chat-model catalog (issue #409).
 *
 * The gateway's model list used to come only from `gateway.models` in
 * config.json, written once at provisioning and never touched again — so a
 * catalog that changed upstream could never reach the `/models` picker or
 * `GET /api/v1/models`. This fetches the catalog from the same endpoint the
 * session already talks to, and falls back to the static list.
 *
 * Provider-agnostic by construction: the base URL and token come from env /
 * `~/.claude/settings.json`, never from a hardcoded vendor host. That mirrors
 * the image tool's catalog fetch (`mcp/tools/image/module.ts`), which solved
 * this same problem for image models. The URL-safety check below is a second
 * implementation of that module's `baseUrlIsSecure` rather than a shared one:
 * `tsconfig.json` pins `rootDir` to `src/`, so nothing here can import from
 * `mcp/`. Keep the two in step.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ModelConfig } from '../types';

/** A stale catalog beats a hung picker — the fetch sits in front of a UI action. */
const CATALOG_TIMEOUT_MS = 5_000;

/**
 * How long a successful fetch is reused. The picker calls this on every press
 * and `GET /api/v1/models` on every request, so an uncached read would put a
 * network round-trip on both. A minute is short enough that a model added
 * upstream shows up while the user is still looking for it.
 */
const CATALOG_TTL_MS = 60_000;

/**
 * How long a catalog stays usable once fetches start failing.
 *
 * Falling straight back to the static list on a blip is worse than it sounds:
 * the static list is the provisioning-time one, so a user running a model that
 * exists only upstream would watch their own model disappear from its picker,
 * and `contextWindowFor` would size their context against the 200k default. A
 * catalog fetched minutes ago is much closer to the truth than that. The bound
 * stops it becoming an unbounded pin on a list nobody can refresh.
 */
const CATALOG_STALE_MS = 60 * 60_000;

/** Model kinds that are not selectable as a chat model. See parseModelCatalog. */
const NON_CHAT_KINDS = new Set(['image', 'video', 'audio', 'speech', 'embedding', 'embeddings', 'rerank', 'moderation']);

/** Fallback context window for a model no catalog — live or static — describes. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

interface CatalogCache {
  models: ModelConfig[];
  fetchedAt: number;
}

let cache: CatalogCache | null = null;
/** In-flight fetch, so N concurrent callers make one request, not N. */
let inFlight: Promise<ModelConfig[] | null> | null = null;
let warnedInsecureUrl = false;

/** Reset module state. Tests only — each case needs a clean cache. */
export function resetModelCatalogCache(): void {
  cache = null;
  inFlight = null;
  warnedInsecureUrl = false;
}

// ── configuration ───────────────────────────────────────────────────────────

// Parsed `env` block of the Claude Code CLI config. The CLI applies that block
// internally rather than to the OS environment, so a value set only there is
// invisible to `process.env` and has to be read from the file.
let settingsEnvCache: Record<string, unknown> | null | undefined;

function settingsEnv(key: string): string {
  if (settingsEnvCache === undefined) {
    try {
      const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
      settingsEnvCache = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))?.env ?? null;
    } catch {
      settingsEnvCache = null;
    }
  }
  const v = settingsEnvCache?.[key];
  return typeof v === 'string' ? v : '';
}

/** Tests only — the settings file is read once per process otherwise. */
export function resetSettingsEnvCache(): void {
  settingsEnvCache = undefined;
}

/**
 * Where to fetch the catalog from. `MODELS_BASE_URL` lets a deployment point
 * the catalog at a different host than the messages endpoint; otherwise it is
 * the same `ANTHROPIC_BASE_URL` the session process already uses. Empty means
 * "not configured", which is the signal to stay on the static list.
 */
export function catalogBaseUrl(): string {
  const raw =
    process.env.MODELS_BASE_URL ||
    process.env.ANTHROPIC_BASE_URL ||
    settingsEnv('ANTHROPIC_BASE_URL');
  return raw.replace(/\/+$/, '');
}

function catalogAuthToken(): string {
  return (
    process.env.MODELS_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    settingsEnv('ANTHROPIC_AUTH_TOKEN') ||
    settingsEnv('CLAUDE_CODE_OAUTH_TOKEN')
  );
}

/**
 * https is required for a public catalog host — the bearer token rides every
 * call. http is tolerated only for a local/internal hop, where cleartext never
 * leaves the machine or network.
 */
export function baseUrlIsSecure(raw: string): boolean {
  if (!raw) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  // WHATWG URL keeps the brackets on an IPv6 host, so `hostname` for
  // http://[::1]:8080 is '[::1]', not '::1'. Comparing against the bare form
  // never matched, and an IPv6-loopback proxy was rejected as insecure.
  // mcp/tools/image/module.ts has the same bug in its copy of this check.
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    h === 'localhost' ||
    h === 'host.docker.internal' ||
    h.endsWith('.internal') ||
    h.endsWith('.local') ||
    /^127\./.test(h) ||
    h === '::1' ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)
  );
}

// ── parsing ─────────────────────────────────────────────────────────────────

/**
 * Turn a catalog response into `ModelConfig[]`, or null when it carries no
 * usable model.
 *
 * Two response shapes are accepted because two are in the wild: Anthropic's
 * `{ data: [{ id, display_name }] }` and the `{ models: [{ id, label }] }`
 * shape this gateway's own endpoints emit. A proxy may front either.
 *
 * `alias`, `contextWindow` and `multiplier` are not part of any catalog
 * response, so they are carried over from the static entry with the same id.
 * That matters beyond cosmetics: `/session` reports context use as a
 * percentage of `contextWindow`, and `/compact` sizes its window from it — a
 * live model that lost those fields would silently report against 200k.
 */
export function parseModelCatalog(body: unknown, fallback: ModelConfig[]): ModelConfig[] | null {
  const rows = Array.isArray(body)
    ? body
    : (typeof body === 'object' && body !== null
      ? ((body as { data?: unknown; models?: unknown }).data
        ?? (body as { models?: unknown }).models)
      : null);
  if (!Array.isArray(rows)) return null;

  const known = new Map(fallback.map((m) => [m.id, m]));
  const seen = new Set<string>();
  // Config is authoritative: retain every curated entry, including local [1m]
  // variants, before adding upstream-only rows.
  const models: ModelConfig[] = [...fallback];
  for (const m of fallback) seen.add(m.id);
  let liveCount = 0;
  let usableCount = 0;
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as { id?: unknown; model_id?: unknown; display_name?: unknown; label?: unknown; name?: unknown; context_window?: unknown; contextWindow?: unknown; alias?: unknown; multiplier?: unknown; token_multiplier?: unknown; kind?: unknown; type?: unknown };
    const idValue = typeof r.id === 'string' ? r.id : r.model_id;
    const id = typeof idValue === 'string' ? idValue.trim() : '';
    if (!id) continue;
    usableCount++;
    if (seen.has(id)) continue;
    // A proxy that fronts image generation alongside chat may serve one
    // catalog for both — the image tool asks for its half with
    // `/v1/models?kind=image`. An image model in the chat picker is selectable
    // and cannot chat, so drop anything that says what it is and does not say
    // chat. A row with no kind/type is kept: most catalogs (Anthropic's
    // included, where `type` is the constant "model") say nothing useful here,
    // and dropping those would empty the list. No request-side `kind=chat` is
    // sent because this repo has no way to know the proxy's chat kind value,
    // and guessing one risks an empty catalog on every deployment.
    const kind = [r.kind, r.type].find((v) => typeof v === 'string' && v.trim());
    if (typeof kind === 'string' && NON_CHAT_KINDS.has(kind.toLowerCase())) continue;
    usableCount++;
    seen.add(id);
    const staticEntry = known.get(id);
    if (staticEntry) continue;
    liveCount++;

    const label = [r.display_name, r.label, r.name].find((v) => typeof v === 'string' && v.trim()) ?? id;
    const ctx = [r.context_window, r.contextWindow].find((v) => typeof v === 'number' && v > 0);
    const multiplierValue = typeof r.multiplier === 'number' ? r.multiplier : r.token_multiplier;
    const multiplier = typeof multiplierValue === 'number' ? multiplierValue : undefined;

    models.push({
      id,
      label: String(label),
      // A live-only model has no curated alias. Falling back to the id keeps
      // `/model <alias>` working for it rather than leaving the field empty.
      alias: (typeof r.alias === 'string' && r.alias.trim()) || id,
      contextWindow: (ctx as number | undefined) ?? DEFAULT_CONTEXT_WINDOW,
      ...(multiplier === undefined ? {} : { multiplier }),
    });
  }
  // An empty catalog is treated as a failed fetch, not as "this deployment has
  // no models": an empty picker is strictly worse than a stale one, and an
  // upstream returning [] is far more likely to be broken than correct.
  return usableCount > 0 ? models : null;
}

// ── fetch ───────────────────────────────────────────────────────────────────

/**
 * Fetch the live catalog, or return null to mean "use the static list".
 *
 * Never throws and never rejects: every caller is a picker or a list endpoint
 * whose correct behaviour on any failure is to show the static list. A cached
 * result is reused for {@link CATALOG_TTL_MS}; concurrent callers share one
 * request.
 */
export async function fetchModelCatalog(
  fallback: ModelConfig[],
  now: number = Date.now(),
): Promise<ModelConfig[] | null> {
  if (cache && now - cache.fetchedAt < CATALOG_TTL_MS) return cache.models;
  if (inFlight) return inFlight;

  // A catalog that is merely stale is still better than the static list, but
  // only while a fetch is actually failing — a successful one below replaces it.
  const stale = cache && now - cache.fetchedAt < CATALOG_STALE_MS ? cache.models : null;

  const base = catalogBaseUrl();
  if (!base) return null; // standalone deployment — static list is the catalog

  if (!baseUrlIsSecure(base)) {
    if (!warnedInsecureUrl) {
      warnedInsecureUrl = true;
      console.warn(
        '[model-catalog] base URL is http to a non-local host — refusing to send the auth token '
        + 'in cleartext. Using the static model list. Use https (or a local/internal host).',
      );
    }
    return null;
  }

  inFlight = (async (): Promise<ModelConfig[] | null> => {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const token = catalogAuthToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(`${base}/v1/models`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
      });
      if (!res.ok) return stale;
      const parsed = parseModelCatalog(await res.json(), fallback);
      // Only a usable catalog is cached, and the cache stamp uses the same
      // clock the TTL check above read. Caching a failure would pin the
      // fallback for a full TTL after one blip.
      if (parsed) cache = { models: parsed, fetchedAt: now };
      return parsed ?? stale;
    } catch {
      return stale; // unreachable, timed out, or unparseable
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
