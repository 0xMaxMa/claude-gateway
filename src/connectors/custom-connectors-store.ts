import * as fsp from 'fs/promises';
import { randomUUID } from 'crypto';
import type { CustomConnectorEntry } from '../types';

/**
 * Read-modify-write access to config.json's `gateway.customConnectors` subtree,
 * extracted out of connectors-router.ts so a second router (oauth-connectors-router.ts)
 * can share the exact same write lock instead of racing an independent one —
 * two routers each holding their own `Promise`-chain lock over the same file
 * would defeat the point of serializing writes at all.
 *
 * One instance is created per gateway process (see gateway-router.ts's
 * constructor) and threaded into every router that touches customConnectors.
 */
export interface CustomConnectorsStore {
  /** Serialised read-modify-write of the whole customConnectors map. */
  mutate(fn: (connectors: Record<string, CustomConnectorEntry>) => void): Promise<void>;
  /** Fresh read — mirrors token-env.ts's "no caching" stance. */
  read(): Promise<Record<string, CustomConnectorEntry>>;
}

export function createCustomConnectorsStore(configPath?: string): CustomConnectorsStore {
  let writeLock: Promise<void> = Promise.resolve();

  async function mutate(
    fn: (connectors: Record<string, CustomConnectorEntry>) => void,
  ): Promise<void> {
    if (!configPath) return; // no persistence target (e.g. tests) — secret store is authoritative
    const run = writeLock.catch(() => {}).then(async () => {
      const raw = await fsp.readFile(configPath, 'utf-8');
      const config = JSON.parse(raw) as {
        gateway?: { customConnectors?: Record<string, CustomConnectorEntry> };
        [k: string]: unknown;
      };
      config.gateway = config.gateway ?? {};
      config.gateway.customConnectors = config.gateway.customConnectors ?? {};
      fn(config.gateway.customConnectors);
      const tmp = `${configPath}.tmp.${randomUUID()}`;
      await fsp.writeFile(tmp, JSON.stringify(config, null, 2), 'utf-8');
      await fsp.rename(tmp, configPath);
    });
    writeLock = run.catch(() => {});
    return run;
  }

  async function read(): Promise<Record<string, CustomConnectorEntry>> {
    if (!configPath) return {};
    try {
      const raw = await fsp.readFile(configPath, 'utf-8');
      const config = JSON.parse(raw) as {
        gateway?: { customConnectors?: Record<string, CustomConnectorEntry> };
      };
      return config.gateway?.customConnectors ?? {};
    } catch {
      return {};
    }
  }

  return { mutate, read };
}
