import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ApiKey } from '../types';

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
  const file =
    configPath ||
    process.env.GATEWAY_CONFIG ||
    path.join(os.homedir(), '.claude-gateway', 'config.json');
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
}

/**
 * Resolve the base URL of the gateway. Precedence:
 *   --url  →  $CLAUDE_GATEWAY_URL  →  config.gateway.publicUrl  →  http://<bind>:<port>
 *
 * A bind of 0.0.0.0 / :: is a listen address, not a dial address, so it is
 * rewritten to loopback for the client. Port comes from $PORT (default 10850).
 * The returned URL has no trailing slash.
 */
export function resolveUrl(i: ResolveInputs = {}): string {
  const env = i.env ?? process.env;
  const cfg = i.config ?? {};
  const explicit = i.flagUrl || env.CLAUDE_GATEWAY_URL || cfg.publicUrl;
  let url: string;
  if (explicit) {
    url = explicit;
  } else {
    let host = cfg.bind || '127.0.0.1';
    if (host === '0.0.0.0' || host === '::' || host === '[::]') host = '127.0.0.1';
    const port = parseInt(env.PORT || String(DEFAULT_PORT), 10) || DEFAULT_PORT;
    url = `http://${host}:${port}`;
  }
  return url.replace(/\/+$/, '');
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
  const url = buildRequestUrl(opts.baseUrl, opts.path, opts.query);
  const headers: Record<string, string> = {};
  if (opts.key) headers['Authorization'] = `Bearer ${opts.key}`;
  const hasBody = opts.body !== undefined && opts.method.toUpperCase() !== 'GET';
  if (hasBody) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method.toUpperCase(),
      headers,
      body: hasBody ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const reason = (err as Error)?.name === 'AbortError' ? `timed out after ${opts.timeoutMs ?? 30_000}ms` : (err as Error).message;
    throw new Error(`Cannot reach gateway at ${opts.baseUrl}: ${reason}`);
  }
  clearTimeout(timer);

  const text = await res.text();
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
