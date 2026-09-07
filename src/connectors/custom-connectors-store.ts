import * as fsp from 'fs/promises';
import type { CustomConnectorEntry } from '../types';
import { withConfigWriteLock, writeConfigAtomic } from '../config/config-write-lock';

/**
 * Read-modify-write access to config.json's `gateway.customConnectors` subtree,
 * extracted out of connectors-router.ts so a second router (oauth-connectors-router.ts)
 * can share the exact same write lock instead of racing an independent one —
 * two routers each holding their own `Promise`-chain lock over the same file
 * would defeat the point of serializing writes at all.
 *
 * That lock is `config/config-write-lock.ts`'s, not a private one, because the same
 * argument applies one level up: api/router.ts, agent/runner.ts and
 * apps/agent-manager.ts all rewrite this file too, and a lock this module owned alone
 * would serialise connector writes against each other while still losing them to an
 * agents-API write that happened to interleave.
 *
 * One instance is created per gateway process (see gateway-router.ts's
 * constructor) and threaded into every router that touches customConnectors.
 */
export interface CustomConnectorsStore {
  /** Serialised read-modify-write of the whole customConnectors map. */
  mutate(fn: (connectors: Record<string, CustomConnectorEntry>) => void): Promise<void>;
  /** Fresh read — mirrors token-env.ts's "no caching" stance. */
  read(): Promise<Record<string, CustomConnectorEntry>>;
  /**
   * Serialised read-DECIDE-write for one connector: `fn` is handed the entry as it
   * stands INSIDE the write lock, and config.json is rewritten only if `fn` calls
   * `remove()`.
   *
   * The routes that act on an existing connector — DELETE and /connect — branch on
   * what they find there: DELETE reads `credentialOwner` to choose between clearing
   * the secret and removing the entry, and `secretNames` to choose which secrets to
   * clear; /connect reads both to decide whether a pasted token belongs here at all.
   * Taking that read outside the lock makes the decision a snapshot of a state that
   * a concurrent /oauth/receive (the one route that rewrites an existing entry's
   * owner and secret names wholesale) may already have replaced — so DELETE would
   * clear secrets under names the entry no longer declares while keeping an entry it
   * should have removed, and /connect would file a pasted token under a name nothing
   * ever reads again. `read()` remains right for the routes that only report.
   *
   * `fn` runs while the lock is held, so it must not call back into this store or
   * `withConfigWriteLock` — the lock is a promise chain, not a reentrant one, and a
   * nested acquire deadlocks. Slow work that does not need the entry (restarting
   * sessions, in particular) belongs after this resolves.
   */
  withEntry<T>(connectorId: string, fn: (write: ConnectorWrite) => T | Promise<T>): Promise<T>;
}

/** What `withEntry` hands its callback. */
export interface ConnectorWrite {
  /** The entry as it stands inside the write lock — `undefined` if there is none. */
  readonly entry: CustomConnectorEntry | undefined;
  /** Hard-delete it: the entry AND every agent's enablement flag for it, in this same write. */
  remove(): void;
}

/**
 * Re-key a parsed connector map onto a null-prototype object. Every map this module
 * hands out — to a caller of `read()`, to a `mutate` callback — goes through here.
 *
 * Connector ids are slugs derived from a user-supplied label, and `isValidConnectorId`
 * accepts `constructor`, `toString`, `valueOf` — all inherited properties of a plain
 * `JSON.parse` result. Every lookup in the routers is a bare `map[id]`, so an id like
 * that resolved to a Function rather than to nothing: `GET /:id/status` answered
 * `500 Connector has an unreadable configuration`, DELETE answered
 * `500 Cannot read properties of undefined (reading 'map')` and `/connect`
 * `... (reading 'length')` — both leaking an internal error message — where the honest
 * answer to all three is 404. A null-prototype map has nothing to inherit, so `map[id]`
 * is undefined exactly when the connector does not exist.
 *
 * `Object.assign` copies own enumerable keys only, which is also what `JSON.stringify`
 * writes back out, so a map that has been through here round-trips unchanged.
 */
function ownKeysOnly(
  map: Record<string, CustomConnectorEntry> | undefined,
): Record<string, CustomConnectorEntry> {
  return Object.assign(Object.create(null) as Record<string, CustomConnectorEntry>, map);
}

/** config.json, as much of its shape as this module touches. */
type ParsedConfig = {
  gateway?: { customConnectors?: Record<string, CustomConnectorEntry> };
  agents?: Array<{ connectors?: Record<string, unknown> }>;
  [k: string]: unknown;
};

export function createCustomConnectorsStore(configPath?: string): CustomConnectorsStore {
  // Per store instance, not per module: one store exists per gateway process, so this
  // is process-wide in production, while tests that build their own store each start
  // from a clean throttle instead of inheriting a previous test's timestamp.
  const READ_FAILURE_LOG_INTERVAL_MS = 60 * 1000;
  let lastReadFailureLog = 0;

  async function mutate(
    fn: (connectors: Record<string, CustomConnectorEntry>) => void,
  ): Promise<void> {
    if (!configPath) return; // no persistence target (e.g. tests) — secret store is authoritative
    return withConfigWriteLock(configPath, async () => {
      const raw = await fsp.readFile(configPath, 'utf-8');
      const config = JSON.parse(raw) as {
        gateway?: { customConnectors?: Record<string, CustomConnectorEntry> };
        [k: string]: unknown;
      };
      config.gateway = config.gateway ?? {};
      // The callback both reads (`slugify(label, Object.keys(c))`, /oauth/receive's
      // `c[id]` capture of the entry it replaces) and writes, so it gets the same
      // null-prototype treatment `read()` gives — see ownKeysOnly.
      const connectors = ownKeysOnly(config.gateway.customConnectors);
      config.gateway.customConnectors = connectors;
      fn(connectors);
      await writeConfigAtomic(configPath, config);
    });
  }

  async function read(): Promise<Record<string, CustomConnectorEntry>> {
    if (!configPath) return ownKeysOnly(undefined);
    try {
      const raw = await fsp.readFile(configPath, 'utf-8');
      const config = JSON.parse(raw) as {
        gateway?: { customConnectors?: Record<string, CustomConnectorEntry> };
      };
      return ownKeysOnly(config.gateway?.customConnectors);
    } catch (err) {
      noteReadFailure(err);
      return ownKeysOnly(undefined);
    }
  }

  /**
   * Degrading to {} is right — see readTokenEnv()'s doc for the same argument: this
   * feeds `GET /v1/connectors`, and a throw from an async Express 4 handler reaches
   * index.ts's `unhandledRejection` hook and shuts the gateway down.
   *
   * But degrading SILENTLY is not. An EACCES config.json (one `sudo`, a restored
   * volume) or a hand-edit that left invalid JSON both land here, and the caller
   * cannot tell "no connectors are configured" from "the file that lists them is
   * unreadable": the caller gets an empty list and the refresh sweep concludes
   * there is nothing to refresh, with nothing written anywhere to say why. It
   * also means connectors-router.ts's `500 Connector configuration could not be
   * read` — the documented answer for exactly this — is unreachable, because
   * this function never throws.
   *
   * A missing file is not that: it is the ordinary pre-first-write state, and
   * says the same thing as an empty map.
   */
  function noteReadFailure(err: unknown): void {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    const now = Date.now();
    // Throttled for readTokenEnv's reason — status pollers hit this every couple
    // of seconds, so one line per failure buries the log it belongs in.
    if (now - lastReadFailureLog < READ_FAILURE_LOG_INTERVAL_MS) return;
    lastReadFailureLog = now;
    console.error(
      `custom-connectors-store: cannot read connectors from ${configPath}` +
        ` (${(err as NodeJS.ErrnoException).code ?? 'invalid JSON'}) — reporting no` +
        ` connectors until it is readable: ${(err as Error).message}`,
    );
  }

  /**
   * The entry AND every agent's enablement flag for it. Returns whether anything went.
   *
   * Both halves, because per-agent enablement is stored separately from the
   * connector entry itself (AgentConfig.connectors vs gateway.customConnectors),
   * so removing only the entry leaves its enablement flags behind as orphans.
   * They are inert while the id is unused — but ids are slugs derived from
   * labels, so re-adding a connector with the same label revives whatever the
   * old one's flags said. An agent that was explicitly disabled for the deleted
   * connector would then start out disabled for the brand-new one, for no reason
   * its owner can see.
   *
   * One write rather than two, because two would reintroduce the very orphan
   * this exists to prevent: a crash — or the emergency shutdown index.ts runs on
   * an unhandled rejection — landing between them leaves the entry gone and the
   * flags behind, and with the entry gone nothing will ever come back for them.
   *
   * Only for a real delete of the entry. A soft disconnect keeps the entry and so
   * must keep its enablement.
   */
  function dropConnector(config: ParsedConfig, connectorId: string): boolean {
    let changed = false;
    // `hasOwnProperty`, not `in`: `'constructor' in {}` is true, so the `in` form
    // deleted nothing (delete on an inherited property is a no-op), reported
    // `changed`, and rewrote config.json for it — see ownKeysOnly for the same
    // hazard on the read side.
    if (
      config.gateway?.customConnectors &&
      Object.prototype.hasOwnProperty.call(config.gateway.customConnectors, connectorId)
    ) {
      delete config.gateway.customConnectors[connectorId];
      changed = true;
    }
    for (const agent of config.agents ?? []) {
      if (agent.connectors && Object.prototype.hasOwnProperty.call(agent.connectors, connectorId)) {
        delete agent.connectors[connectorId];
        changed = true;
      }
    }
    return changed;
  }

  async function withEntry<T>(
    connectorId: string,
    fn: (write: ConnectorWrite) => T | Promise<T>,
  ): Promise<T> {
    if (!configPath) {
      // No persistence target (tests): the same "there is nothing there" `read()`
      // reports, and a `remove()` that has nothing to remove.
      return fn({ entry: undefined, remove: () => {} });
    }
    return withConfigWriteLock(configPath, async () => {
      let config: ParsedConfig | null = null;
      try {
        config = JSON.parse(await fsp.readFile(configPath, 'utf-8')) as ParsedConfig;
      } catch (err) {
        // Same degrade-and-log as read(): the callers reach this through a route
        // that would already have answered 404 off `read()`'s empty map, so an
        // unreadable config keeps meaning "no such connector" rather than
        // rejecting into index.ts's unhandledRejection hook.
        noteReadFailure(err);
      }
      const connectors = ownKeysOnly(config?.gateway?.customConnectors);
      let removeRequested = false;
      const result = await fn({
        entry: connectors[connectorId],
        remove: () => {
          removeRequested = true;
        },
      });
      if (!removeRequested) return result; // decided to keep it — nothing to write
      if (!config) {
        // Unreachable through the routes (no entry to act on means they 404 first),
        // and a lie if it ever were: answering "removed" for a file we could not
        // read. Surfaces as a 500 instead.
        throw new Error(`Cannot remove connector '${connectorId}': ${configPath} is unreadable`);
      }
      if (dropConnector(config, connectorId)) await writeConfigAtomic(configPath, config);
      return result;
    });
  }

  return { mutate, read, withEntry };
}
