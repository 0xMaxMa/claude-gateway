/**
 * Custom (user-pasted) connector helpers — id generation, placeholder
 * extraction, and secret substitution. These entries are admin-trusted data,
 * not code — see CustomConnectorEntry's doc comment in connectors/types.ts.
 */

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
