/**
 * Custom (user-pasted) connector helpers — id generation, placeholder
 * extraction, and secret substitution. Kept separate from catalog.ts (the
 * code-reviewed, built-in tier) because these entries are admin-trusted data,
 * not code — see CustomConnectorEntry's doc comment in connectors/types.ts.
 */

import { CONNECTOR_CATALOG } from './catalog';

const PLACEHOLDER_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

/** Lowercase, dash-separated id from a human label, e.g. "Google Calendar!" → "google-calendar". */
function slugBase(label: string): string {
  const slug = label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'connector';
}

/**
 * A slug not already used by a built-in catalog id or an existing custom id.
 * Appends -2, -3, ... on collision (custom ids are user-facing, not secret,
 * so a readable suffix beats a random one).
 */
export function slugify(label: string, existingCustomIds: Iterable<string>): string {
  const taken = new Set<string>(CONNECTOR_CATALOG.map((c) => c.id));
  for (const id of existingCustomIds) taken.add(id);

  const base = slugBase(label);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
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
