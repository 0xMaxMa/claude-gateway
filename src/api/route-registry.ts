import type { Router, RequestHandler } from 'express';

/**
 * Route registry — the single source of truth that ties an HTTP route to its
 * friendly CLI command and its documentation entry.
 *
 * A converted router registers each route with {@link defineRoute}, which does
 * two things in one call:
 *   1. mounts the handler on the Express router exactly as `router.get(...)` would, and
 *   2. records the route's metadata (method, path, auth, CLI mapping) into a
 *      module-global manifest.
 *
 * Because the mount and the metadata come from the same call, they can never
 * drift. The manifest feeds:
 *   - `GET /api/v1/_meta/routes` at runtime (populated as routers are created), and
 *   - `scripts/gen-cli.ts` at build time (which calls each converted router
 *     factory with throwaway deps to populate the manifest WITHOUT booting the
 *     server — handlers are mounted but never invoked, so no deps are needed).
 *
 * Adding a CLI-exposed endpoint is therefore a single edit: one `defineRoute`
 * call yields the API route, the CLI command, and the doc entry together.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

/** Auth requirement for a route, for docs/help only (the actual enforcement is
 *  the router's own middleware — this is descriptive metadata). */
export type AuthLevel = 'none' | 'key' | 'admin';

/** A CLI flag derived from a query or body parameter. */
export interface CliFlag {
  /** Flag name as typed on the CLI, e.g. `agent` → `--agent`. */
  name: string;
  /** Where the value is sent: query string or request body. */
  in: 'query' | 'body';
  /** A boolean flag (`--force`) takes no value. */
  boolean?: boolean;
  required?: boolean;
  description?: string;
}

/** Maps a route to a friendly `<noun> <verb>` CLI command. */
export interface CliMapping {
  /** Resource group, plural for resources (`crons`, `agents`, `sessions`). */
  noun: string;
  /** Action within the noun (`list`, `create`, `run`, `restart`). */
  verb: string;
  /** Path params in order → positional CLI args (`:id` → `['id']`). */
  args?: string[];
  /** Query/body params exposed as `--flags`. Body-heavy routes may also accept a
   *  generic `--data <json>`; declared body flags are merged over it. */
  flags?: CliFlag[];
}

/** One route's metadata. `cli: null` marks a route intentionally NOT exposed as
 *  a friendly command (still reachable via the `api` passthrough). */
export interface RouteDef {
  method: HttpMethod;
  path: string;
  auth: AuthLevel;
  summary: string;
  cli?: CliMapping | null;
}

const registered: RouteDef[] = [];

/** Clear the manifest. Call before repopulating (codegen, tests). */
export function resetRegisteredRoutes(): void {
  registered.length = 0;
}

/** Snapshot of the manifest (deep-copied so callers can't mutate it). */
export function getRegisteredRoutes(): RouteDef[] {
  return registered.map((r) => ({ ...r, cli: r.cli ? { ...r.cli } : r.cli }));
}

function metaKey(method: string, path: string): string {
  return `${method} ${path}`;
}

/**
 * Mount `handlers` on `router` for `def.method`/`def.path` (identical to
 * `router[method](path, ...handlers)`) AND record `def` in the manifest.
 *
 * The metadata is deduped by `method + path` so that calling a router factory
 * more than once (as tests do per-app, and codegen does across a run) does not
 * pile up duplicate entries. The mount always happens so each router instance
 * gets its own routes.
 */
export function defineRoute(router: Router, def: RouteDef, ...handlers: RequestHandler[]): void {
  const key = metaKey(def.method, def.path);
  if (!registered.some((r) => metaKey(r.method, r.path) === key)) {
    registered.push({ ...def, cli: def.cli ? { ...def.cli } : def.cli });
  }
  const m = def.method.toLowerCase() as Lowercase<HttpMethod>;
  router[m](def.path, ...handlers);
}
