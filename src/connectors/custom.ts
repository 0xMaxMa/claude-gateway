/**
 * Custom (user-pasted) connector helpers — id generation, placeholder
 * extraction, and secret substitution. These entries are admin-trusted data,
 * not code — see CustomConnectorEntry's doc comment in connectors/types.ts.
 */

import type { CustomConnectorEntry } from './types';

const PLACEHOLDER_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

/**
 * Lowercase, dash-separated id from a human label, e.g. "Google Calendar!" → "google-calendar".
 *
 * Truncated to `budget` characters (and re-trimmed, so a cut that lands on a dash
 * doesn't leave a trailing one). See `slugify` for why the cap is not optional.
 */
function slugBase(label: string, budget: number): string {
  const slug = label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, budget)
    .replace(/-+$/g, '');
  return slug || 'connector';
}

/**
 * MCP server names the gateway writes into every session's mcp-config.json itself
 * (see session/process.ts's writeMcpConfig). That writer drops any injected entry whose
 * key collides — a correct guard, but a silent one: a connector landing on one of these
 * ids is created, stores its secret, and reports "Connected ✓" while never reaching a
 * session, unfixable except by deleting it. Reserving the names where ids are minted
 * turns that into a different, working id.
 *
 * Exported so process.ts's skip list is this same set, not a second copy of the
 * literals — a name added there but not here silently reopens the hole.
 */
export const RESERVED_CONNECTOR_IDS: ReadonlySet<string> = new Set(['gateway', 'telegram']);

export function isReservedConnectorId(id: string): boolean {
  return RESERVED_CONNECTOR_IDS.has(id);
}

/**
 * A slug not already used by a reserved id or an existing custom id. Appends
 * -2, -3, ... on collision (custom ids are user-facing, not secret, so a readable
 * suffix beats a random one).
 *
 * The result is always a valid connector id, length included. Every management route
 * takes the id back from the URL and runs it through `isValidConnectorId`, so an id
 * this function emits but that one rejects produces a connector that resolves into
 * sessions and works — yet whose status, connect, delete and oauth/start routes all
 * answer 400, fixable only by hand-editing config.json. The base is therefore truncated
 * with the collision suffix's width already reserved.
 *
 * Managed ids like 'github'/'gmail' are NOT reserved here — an external control plane
 * pushes those in, so a user-added connector could slug-collide with one. Accepted as a
 * self-recoverable edge case (both paths are admin-trusted) rather than hardcoding
 * another system's ids. RESERVED_CONNECTOR_IDS is reserved because that collision is
 * NOT self-recoverable.
 */
export function slugify(label: string, existingCustomIds: Iterable<string>): string {
  const taken = new Set<string>(RESERVED_CONNECTOR_IDS);
  for (const id of existingCustomIds) taken.add(id);

  const base = slugBase(label, MAX_CONNECTOR_ID_LENGTH);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    // Re-slug against a smaller budget rather than trimming `base`, so the cut
    // still lands on a clean boundary as the suffix grows past one digit.
    const candidate = `${slugBase(label, MAX_CONNECTOR_ID_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Recursively collect every unique {name} placeholder found in string values. */
export function extractPlaceholders(config: unknown): string[] {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const m of value.matchAll(PLACEHOLDER_RE)) found.add(m[1]);
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === 'object') {
      Object.values(value as Record<string, unknown>).forEach(walk);
    }
  };
  walk(config);
  return [...found];
}

/** Recursively replace every {name} in string values with secrets[name] (or '' if absent). */
export function substitutePlaceholders(
  config: Record<string, unknown>,
  secrets: Record<string, string>,
): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value.replace(PLACEHOLDER_RE, (_match, name: string) => secrets[name] ?? '');
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v)]),
      );
    }
    return value;
  };
  return walk(config) as Record<string, unknown>;
}

/** Namespaced mcp-token.env key so two custom connectors reusing {api_key} don't collide. */
export function customSecretKey(id: string, name: string): string {
  return `CUSTOM__${id}__${name}`;
}

/** What `connected` means on every status surface: every secret the entry declares is stored. */
export function hasAllSecrets(id: string, entry: Pick<CustomConnectorEntry, 'secretNames'>, tokenEnv: Record<string, string>): boolean {
  return entry.secretNames.every(name => !!tokenEnv[customSecretKey(id, name)]);
}

/**
 * Namespaced key for gateway-internal bookkeeping about a connector (the refresh
 * token, its expiry, failure counters — see oauth-refresh-sweep.ts), stored in the
 * same file but under a prefix `customSecretKey()` can never produce.
 *
 * The separate prefix is the whole point: `PLACEHOLDER_RE` accepts a leading
 * underscore, so a pasted `{__refresh_token}` DOES yield `__refresh_token` as a
 * secretName. Sharing one prefix would make `customSecretKey(id, '__refresh_token')`
 * and the sweep's own slot the same string — a pasted config that resolves the
 * gateway's refresh token into an outbound header. `isReservedPlaceholder` reports that
 * at add-time; this split makes it unreachable even if a caller forgets to validate.
 */
export function internalSecretKey(id: string, name: string): string {
  return `CUSTOMINT__${id}__${name}`;
}

/**
 * Placeholder names the gateway reserves for itself. Rejected when adding or pushing
 * a connector so the admin gets a clear 400 instead of a placeholder that silently
 * resolves to the empty string.
 */
export function isReservedPlaceholder(name: string): boolean {
  return name.startsWith('__');
}

/**
 * Connector ids are config.json object keys and are interpolated into mcp-token.env
 * key names, so they are constrained to the shape `slugify()` produces. Routes taking
 * an `:id` from the URL must check this first — `/oauth/receive` in particular names a
 * connector it is creating, so there is no existing entry to validate against.
 */
const CONNECTOR_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Upper bound shared by the generator (`slugify`) and the validator below so the two
 * can't drift — see slugify's doc comment for what happens when they do.
 */
export const MAX_CONNECTOR_ID_LENGTH = 64;

export function isValidConnectorId(id: string): boolean {
  return id.length <= MAX_CONNECTOR_ID_LENGTH && CONNECTOR_ID_RE.test(id);
}

/**
 * How a secret-bearing connector reaches an agent without its secret being written
 * into an agent-readable file (#635):
 *
 *   'none'     No secret; the entry is written as configured.
 *   'proxy'    An HTTP entry. The file points Claude Code's own HTTP transport at the
 *              gateway's loopback proxy, which adds `url`/`headers` (connectors/proxy.ts).
 *   'launch'   A stdio or SSE entry. The file holds a stdio launcher that streams the
 *              MCP session to a gateway-spawned bridge, which receives the resolved
 *              entry over a pipe (mcp/connector-launcher.mjs, mcp/connector-bridge.ts).
 *   'exposed'  Still written resolved, exactly as before #635: the entry has a field
 *              only Claude Code itself can act on (`headersHelper` runs a command whose
 *              headers it adds per request, `oauth` starts its own sign-in against the
 *              entry's url), or a transport the gateway cannot carry (`ws`). Either
 *              field breaks behind the proxy even without a placeholder: the helper's
 *              headers would be dropped there, and sign-in would target the proxy URL.
 *
 * A placeholder in any other field is resolved in the gateway and that field is left
 * out of the agent-facing entry; no transport the gateway drives reads it.
 */
export type ConnectorSecretRoute = 'none' | 'proxy' | 'launch' | 'exposed';

const CLIENT_ONLY_FIELDS = ['headersHelper', 'oauth'];

export function connectorSecretRoute(entry: CustomConnectorEntry | undefined): ConnectorSecretRoute {
  // A sidecar's url is a loopback port the gateway allocates and may change on restart,
  // so it is never written into a session's config, secret or not.
  if (entry?.config && typeof entry.config === 'object' && entry.config.sidecar !== undefined) return 'proxy';
  if (!entry || !Array.isArray(entry.secretNames) || !entry.secretNames.length) return 'none';
  const config = entry.config;
  if (!config || typeof config !== 'object') return 'exposed';
  if (CLIENT_ONLY_FIELDS.some(field => config[field] !== undefined)) return 'exposed';
  if (isStreamableHttpType(config.type)) return 'proxy';
  if (config.type === 'sse') return 'launch';
  if ((config.type === undefined || config.type === 'stdio') && typeof config.command === 'string') return 'launch';
  return 'exposed';
}

/** Fields the gateway drives each transport with, plus `confirmTools`, which the gateway
 * renders into worker prompts; never copied into an agent-facing entry. */
const TRANSPORT_FIELDS = ['type', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'sidecar', 'confirmTools'];

/** The configured fields an agent-facing entry keeps (enabled_tools, timeout, ...):
 * everything except the transport fields and any field holding a placeholder. The
 * unresolved config holds `{placeholder}`s, never secrets, so nothing here is one. */
export function agentFacingFields(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([field, value]) =>
    !TRANSPORT_FIELDS.includes(field) && !extractPlaceholders(value).length));
}

/** The streamable-HTTP transport, under either name a pasted mcpServers entry uses. */
export function isStreamableHttpType(type: unknown): boolean {
  return type === 'http' || type === 'streamable-http';
}

/** True when resolving this connector still writes its secret into an agent-readable file. */
export function exposesSecretToAgent(entry: CustomConnectorEntry): boolean {
  return connectorSecretRoute(entry) === 'exposed';
}

const CONFIRM_TOOL_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_CONFIRM_TOOLS = 64;

/**
 * `config.confirmTools`: tool names a worker must confirm with the user before calling.
 * Structured data only, so the worker prompt line built from it is a fixed template and
 * a connector's free text never reaches a worker as an instruction. `undefined` when
 * absent. Run at the API boundary (a 400) and again when rendering, since config.json
 * can also be edited by hand.
 */
export function parseConfirmTools(config: Record<string, unknown>): string[] | { error: string } | undefined {
  const raw = config.confirmTools;
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.every(name => typeof name === 'string' && CONFIRM_TOOL_RE.test(name))) {
    return { error: 'confirmTools must be an array of tool names matching [A-Za-z0-9_.-]{1,64}' };
  }
  if (raw.length > MAX_CONFIRM_TOOLS) return { error: `confirmTools must list at most ${MAX_CONFIRM_TOOLS} tools` };
  if (new Set(raw).size !== raw.length) return { error: 'confirmTools must not repeat a tool name' };
  return raw as string[];
}

/** Without confirmTools: the gateway reads it, the connector's MCP server never does. */
export function withoutConfirmTools(server: Record<string, unknown>): Record<string, unknown> {
  if (server.confirmTools === undefined) return server;
  const { confirmTools: _confirmTools, ...rest } = server;
  return rest;
}
