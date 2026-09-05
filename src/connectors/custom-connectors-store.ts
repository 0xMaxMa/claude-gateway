import * as fsp from 'fs/promises';
import { randomUUID } from 'crypto';
import type { CustomConnectorEntry } from '../types';
import { withConfigWriteLock } from '../config/config-write-lock';

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
   * Drop `connectorId` from every agent's `connectors` map.
   *
   * Per-agent enablement is stored separately from the connector entry itself
   * (AgentConfig.connectors vs gateway.customConnectors), so deleting a connector
   * leaves its enablement flags behind as orphans. They are inert while the id is
   * unused — but ids are slugs derived from labels, so re-adding a connector with
   * the same label revives whatever the old one's flags said. An agent that was
   * explicitly disabled for the deleted connector would then start out disabled
   * for the brand-new one, for no reason its owner can see.
   *
   * Only for a real delete of the entry. A soft disconnect keeps the entry and so
   * must keep its enablement.
   */
  removeAgentEnablement(connectorId: string): Promise<void>;
}

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
      config.gateway.customConnectors = config.gateway.customConnectors ?? {};
      fn(config.gateway.customConnectors);
      const tmp = `${configPath}.tmp.${randomUUID()}`;
      // mode: 0o600 — config.json carries the admin API key and every agent's
      // channel bot tokens; rename() carries this file's mode onto it, so an
      // unmoded tmp file silently downgrades an existing 0600 config to 0644
      // (issue #460). The uuid suffix means this path is never a stale leftover,
      // so writeFile's mode is always the one that lands.
      await fsp.writeFile(tmp, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
      await fsp.rename(tmp, configPath);
    });
  }

  async function read(): Promise<Record<string, CustomConnectorEntry>> {
    if (!configPath) return {};
    try {
      const raw = await fsp.readFile(configPath, 'utf-8');
      const config = JSON.parse(raw) as {
        gateway?: { customConnectors?: Record<string, CustomConnectorEntry> };
      };
      return config.gateway?.customConnectors ?? {};
    } catch (err) {
      // Degrading to {} is right — see readTokenEnv()'s doc for the same argument:
      // this feeds `GET /v1/connectors`, and a throw from an async Express 4 handler
      // reaches index.ts's `unhandledRejection` hook and shuts the gateway down.
      //
      // But degrading SILENTLY is not. An EACCES config.json (one `sudo`, a restored
      // volume) or a hand-edit that left invalid JSON both land here, and the caller
      // cannot tell "no connectors are configured" from "the file that lists them is
      // unreadable": the panel shows an empty list and the refresh sweep concludes
      // there is nothing to refresh, with nothing written anywhere to say why. It
      // also means connectors-router.ts's `500 Connector configuration could not be
      // read` — the documented answer for exactly this — is unreachable, because
      // this function never throws.
      //
      // A missing file is not that: it is the ordinary pre-first-write state, and
      // says the same thing as an empty map.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        const now = Date.now();
        // Throttled for readTokenEnv's reason — the panel polls this every couple of
        // seconds, so one line per failure buries the log it belongs in.
        if (now - lastReadFailureLog >= READ_FAILURE_LOG_INTERVAL_MS) {
          lastReadFailureLog = now;
          console.error(
            `custom-connectors-store: cannot read connectors from ${configPath}` +
              ` (${(err as NodeJS.ErrnoException).code ?? 'invalid JSON'}) — reporting no` +
              ` connectors until it is readable: ${(err as Error).message}`,
          );
        }
      }
      return {};
    }
  }

  async function removeAgentEnablement(connectorId: string): Promise<void> {
    if (!configPath) return; // no persistence target (e.g. tests)
    return withConfigWriteLock(configPath, async () => {
      const raw = await fsp.readFile(configPath, 'utf-8');
      const config = JSON.parse(raw) as {
        agents?: Array<{ connectors?: Record<string, unknown> }>;
        [k: string]: unknown;
      };
      let changed = false;
      for (const agent of config.agents ?? []) {
        if (agent.connectors && connectorId in agent.connectors) {
          delete agent.connectors[connectorId];
          changed = true;
        }
      }
      if (!changed) return; // don't rewrite the file for nothing
      const tmp = `${configPath}.tmp.${randomUUID()}`;
      // mode: 0o600 — see mutate() above; rename() carries the tmp file's mode.
      await fsp.writeFile(tmp, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
      await fsp.rename(tmp, configPath);
    });
  }

  return { mutate, read, removeAgentEnablement };
}
