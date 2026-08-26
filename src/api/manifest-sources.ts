import { resetRegisteredRoutes, getRegisteredRoutes, RouteDef } from './route-registry';
import { createCronRouter } from './cron-router';

/**
 * Populate the route manifest by instantiating every CONVERTED router with
 * throwaway deps. Each factory's defineRoute() calls mount their routes (which
 * records metadata) but the handlers are never invoked here, so the deps do not
 * need to be real.
 *
 * This is the single list of converted routers: when a router is migrated to
 * defineRoute, add its factory call below and both the offline codegen
 * (scripts/gen-cli.ts) and the sync test pick it up automatically.
 */
export function collectManifest(): RouteDef[] {
  resetRegisteredRoutes();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createCronRouter(undefined as any);

  return getRegisteredRoutes();
}

/** The subset of the manifest exposed as friendly CLI commands. */
export function cliRoutes(): RouteDef[] {
  return collectManifest().filter((r) => r.cli);
}
