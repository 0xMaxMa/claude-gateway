import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ApiKey } from '../types';
import { readLocalGateway, LocalGateway } from './manager';

/**
 * CLI HTTP client — resolves where to talk to the gateway and which key to use,
 * then makes the request. Kept deliberately light: it reads the config JSON
 * directly rather than going through the server's loadConfig() (no validation,
 * migration, or server-side side effects), so the CLI stays fast and works even
 * when the gateway is misconfigured or down.
 *
 * Resolution never prints the API key.
 */

export const DEFAULT_PORT = 10850;

/** Expand a leading `~` to the home directory. Env vars (e.g. `GATEWAY_CONFIG`
 *  set via Docker/systemd) are not shell-expanded, so a literal `~` must be
 *  resolved here or the path silently fails to resolve. */
export function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** The slice of gateway config the CLI cares about. */
export interface CliConfigView {
  bind?: string;
  publicUrl?: string;
  keys?: ApiKey[];
  logDir?: string;
}

/** Read ~/.claude-gateway/config.json (or an override path) and extract the
 *  fields the CLI needs. Returns an empty view if the file is missing/unreadable
 *  so that flags/env can still drive resolution. */
export function loadCliConfig(configPath?: string): CliConfigView {
  const file = expandHome(
    configPath ||
      process.env.GATEWAY_CONFIG ||
      path.join(os.homedir(), '.claude-gateway', 'config.json')
  );
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const json = JSON.parse(raw) as { gateway?: { bind?: string; publicUrl?: string; logDir?: string; api?: { keys?: ApiKey[] } } };
    return {
      bind: json.gateway?.bind,
      publicUrl: json.gateway?.publicUrl,
      keys: json.gateway?.api?.keys,
      logDir: json.gateway?.logDir,
    };
  } catch {
    return {};
  }
}

export interface ResolveInputs {
  /** `--url` / `--key` values (undefined if not passed). */
  flagUrl?: string;
  flagKey?: string;
  /** process.env (injectable for tests). */
  env?: NodeJS.ProcessEnv;
  config?: CliConfigView;
  /** The gateway process running on this host (with the port it listens on),
   *  or null when there is none. Injectable for tests; defaults to the pidfile
   *  read in `manager.ts`. */
  localGateway?: () => LocalGateway | null;
}

/** Where a command will be sent, and where to retry if that address is dead. */
export interface UrlPlan {
  baseUrl: string;
  /** A second address for the *same* gateway, tried once when `baseUrl` cannot
   *  be reached at all. Absent when there is no second address, or when the
   *  caller named one explicitly. */
  fallbackUrl?: string;
}

/**
 * Resolve where the CLI should talk to the gateway. Precedence:
 *   --url  →  $CLAUDE_GATEWAY_URL  →  http://<bind>:<port> *when a gateway is
 *   running on this host*  →  config.gateway.publicUrl  →  http://<bind>:<port>
 *
 * `config.gateway.publicUrl` describes *this* gateway as seen from outside,
 * so when the gateway is running here, loopback and the public URL are the
 * same server — the public one just adds a reverse-proxy hop. Preferring it
 * from the gateway's own host makes every command depend on that proxy, and a
 * proxy enforcing its own authentication (which the CLI has no credentials
 * for) answers 401 to commands that work perfectly over loopback. So a live
 * local gateway wins; `--url` and `$CLAUDE_GATEWAY_URL` still override, for
 * deliberately exercising the proxy path or reaching another host.
 *
 * Liveness comes from a pidfile, which can lie: a gateway killed without
 * cleanup leaves one behind, and the OS may reissue that pid to an unrelated
 * process. The local address would then be preferred and nothing would answer
 * it, so `publicUrl` is returned as `fallbackUrl` — the same gateway by its
 * other name — for the caller to retry once. That cost is paid only when the
 * local address is genuinely unreachable.
 *
 * A bind of 0.0.0.0 / :: is a listen address, not a dial address, so it is
 * rewritten to loopback for the client. The port comes from the pidfile when a
 * gateway is running (see readLocalGateway), else $PORT, else 10850. The
 * returned URLs have no trailing slash.
 */
export function resolveUrlPlan(i: ResolveInputs = {}): UrlPlan {
  const env = i.env ?? process.env;
  const cfg = i.config ?? {};
  const explicit = i.flagUrl || env.CLAUDE_GATEWAY_URL;
  // An address the caller named is the address used, with no second guess:
  // silently retrying somewhere else would defeat the point of naming it.
  if (explicit) return { baseUrl: stripSlash(explicit) };

  const publicUrl = cfg.publicUrl ? stripSlash(cfg.publicUrl) : undefined;
  const local = (i.localGateway ?? readLocalGateway)();
  if (!local) return { baseUrl: publicUrl ?? bindUrl(cfg, env) };

  const baseUrl = bindUrl(cfg, env, local.port);
  return publicUrl && publicUrl !== baseUrl ? { baseUrl, fallbackUrl: publicUrl } : { baseUrl };
}

/** The base URL alone — see resolveUrlPlan() for the precedence and why. */
export function resolveUrl(i: ResolveInputs = {}): string {
  return resolveUrlPlan(i).baseUrl;
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** `http://<bind>:<port>` — where a gateway on THIS host actually listens.
 *  `knownPort` is the port a running gateway reported through its pidfile; it
 *  wins over `$PORT`, which describes the CLI's own shell and may have nothing
 *  to do with the shell the server was started from. */
function bindUrl(cfg: CliConfigView, env: NodeJS.ProcessEnv, knownPort?: number): string {
  let host = cfg.bind || '127.0.0.1';
  if (host === '0.0.0.0' || host === '::' || host === '[::]') host = '127.0.0.1';
  const port = knownPort ?? (parseInt(env.PORT || String(DEFAULT_PORT), 10) || DEFAULT_PORT);
  return `http://${host}:${port}`;
}

/**
 * Resolve the URL for probing the gateway *process on this host* — used by
 * `gateway status` and by `service install`'s post-install health check.
 * Precedence:
 *   --url  →  http://<bind>:<port>
 *
 * Deliberately NOT resolveUrl(): `config.gateway.publicUrl` (and
 * `$CLAUDE_GATEWAY_URL`) usually point at a reverse proxy, which may be
 * unreachable from the box itself — or, worse, still answering from a
 * different instance, so a dead local service would be reported healthy.
 * An explicit `--url` still wins, for deliberately checking another host.
 */
export function resolveLocalUrl(i: ResolveInputs = {}): string {
  const env = i.env ?? process.env;
  if (i.flagUrl) return stripSlash(i.flagUrl);
  const local = (i.localGateway ?? readLocalGateway)();
  return stripSlash(bindUrl(i.config ?? {}, env, local?.port));
}

/**
 * Resolve the API key. Precedence:
 *   --key  →  $CLAUDE_GATEWAY_API_KEY  →  first admin key in config  →  first key in config
 *
 * Returns undefined if none is available. The key is never logged.
 */
export function resolveKey(i: ResolveInputs = {}): string | undefined {
  const env = i.env ?? process.env;
  const cfg = i.config ?? {};
  if (i.flagKey) return i.flagKey;
  if (env.CLAUDE_GATEWAY_API_KEY) return env.CLAUDE_GATEWAY_API_KEY;
  const keys = cfg.keys ?? [];
  const admin = keys.find((k) => k.admin);
  if (admin) return admin.key;
  return keys[0]?.key;
}

export interface RequestOptions {
  method: string;
  /** API path beginning with /v1 (mounted under /api server-side). */
  path: string;
  baseUrl: string;
  key?: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  /** Abort the request after this many ms (default 30000). */
  timeoutMs?: number;
  /** A second address for the same gateway, tried once when `baseUrl` cannot be
   *  reached at all (see resolveUrlPlan). An HTTP error is never retried — the
   *  gateway answered, and repeating the call elsewhere would hide that. */
  fallbackBaseUrl?: string;
  /** Called before the retry, so the switch is never silent. Injectable for
   *  tests; defaults to a one-line note on stderr. */
  onFallback?: (from: string, to: string, reason: string) => void;
}

/** A request that never reached a server (DNS, refused, timeout) — as opposed
 *  to one the gateway answered with an error status. Only the former is worth
 *  retrying at a different address. */
class TransportError extends Error {
  readonly transport = true;
}

export interface RequestResult {
  status: number;
  ok: boolean;
  /** Parsed JSON when the response is JSON, otherwise the raw text. */
  data: unknown;
}

/** Build the full request URL: `${baseUrl}/api${path}` plus any query string. */
export function buildRequestUrl(baseUrl: string, apiPath: string, query?: Record<string, string | undefined>): string {
  const base = baseUrl.replace(/\/+$/, '');
  const p = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  let url = `${base}/api${p}`;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== '') qs.append(k, v);
    }
    const s = qs.toString();
    if (s) url += `?${s}`;
  }
  return url;
}

/**
 * Make an authenticated request to the gateway. Throws a clear Error (with the
 * server's message when present) on a non-2xx response or a transport failure,
 * so command wrappers can surface it and exit non-zero.
 */
export async function request(opts: RequestOptions): Promise<RequestResult> {
  try {
    return await attempt(opts.baseUrl, opts);
  } catch (err) {
    if (!opts.fallbackBaseUrl || !(err instanceof TransportError)) throw err;
    const notify =
      opts.onFallback ??
      ((from, to, reason) =>
        process.stderr.write(`Cannot reach the gateway at ${from} (${reason}); retrying at ${to}.\n`));
    notify(opts.baseUrl, opts.fallbackBaseUrl, (err as Error).message);
    return attempt(opts.fallbackBaseUrl, opts);
  }
}

/** One request against one base URL. Throws TransportError when nothing
 *  answered, a plain Error when the gateway answered with a non-2xx. */
async function attempt(baseUrl: string, opts: RequestOptions): Promise<RequestResult> {
  const url = buildRequestUrl(baseUrl, opts.path, opts.query);
  const headers: Record<string, string> = {};
  if (opts.key) headers['Authorization'] = `Bearer ${opts.key}`;
  const hasBody = opts.body !== undefined && opts.method.toUpperCase() !== 'GET';
  if (hasBody) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  let text: string;
  try {
    try {
      res = await fetch(url, {
        method: opts.method.toUpperCase(),
        headers,
        body: hasBody ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      const reason = (err as Error)?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : (err as Error).message;
      throw new TransportError(`Cannot reach gateway at ${baseUrl}: ${reason}`);
    }
    try {
      // Inside the same deadline: `fetch` resolves once the headers arrive, so
      // a gateway that wedges mid-body would otherwise hang the CLI forever.
      text = await res.text();
    } catch (err) {
      // Not a TransportError — the gateway answered, so falling back to another
      // address would only re-ask the same wedged process through a proxy.
      const reason = (err as Error)?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : (err as Error).message;
      throw new Error(`Gateway at ${baseUrl} answered but the response body failed: ${reason}`);
    }
  } finally {
    // In `finally`: a rejected fetch or body read would otherwise leave a live
    // timer holding the event loop open.
    clearTimeout(timer);
  }

  let data: unknown = text;
  const ctype = res.headers.get('content-type') || '';
  if (ctype.includes('application/json') || (text.startsWith('{') || text.startsWith('['))) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    const serverMsg =
      data && typeof data === 'object' && 'error' in (data as Record<string, unknown>)
        ? String((data as Record<string, unknown>).error)
        : typeof data === 'string' && data
          ? data
          : res.statusText;
    throw new Error(`HTTP ${res.status} ${opts.method.toUpperCase()} ${opts.path}: ${serverMsg}`);
  }

  return { status: res.status, ok: res.ok, data };
}

/**
 * Resolve a plan down to one base URL that something is actually answering on.
 *
 * `request()` carries the stale-pidfile fallback per call, which suits the
 * one-shot commands. The interactive flows (`agents`, `channels`) thread a
 * single base URL through many helpers and many requests, so they settle the
 * question once up front instead: if the local address answers nothing, the
 * whole session runs against `publicUrl`.
 *
 * Costs one extra `/health` round trip, and only when a fallback exists at all
 * — that is, only when a pidfile pointed at a gateway on this host.
 */
export async function resolveReachableUrl(plan: UrlPlan): Promise<string> {
  if (!plan.fallbackUrl) return plan.baseUrl;
  const { probeHealth } = await import('./health');
  const probe = await probeHealth(plan.baseUrl);
  // `answered` rather than `ok`: a 401 or 500 means the gateway is there, and
  // asking a different address would only hide its answer.
  if (probe.answered) return plan.baseUrl;
  process.stderr.write(
    `Cannot reach the gateway at ${plan.baseUrl} (${probe.detail}); using ${plan.fallbackUrl}.\n`,
  );
  return plan.fallbackUrl;
}
