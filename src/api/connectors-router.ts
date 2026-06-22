import { Router, Request, Response } from 'express';
import * as fsp from 'fs/promises';
import { randomUUID } from 'crypto';
import { ApiKey } from '../types';
import { createApiAuthMiddleware, isAdmin } from './auth';
import { getConnectorSpec } from '../connectors/catalog';
import { listConnectorStatus } from '../connectors/resolve';
import { secretEnvOf } from '../connectors/types';
import { setSecret, deleteSecret, hasSecret } from '../connectors/token-env';

type AuthedRequest = Request & { apiKey: ApiKey };

/**
 * Connector management API. The gateway acts as catalog + secret manager + config
 * injector: connecting a connector stores its secret in mcp-token.env and records the
 * non-secret wiring in config.json (gateway.connectors). The actual MCP server is
 * injected into each session by SessionProcess (see resolveEnabledConnectors).
 *
 * Routes (mounted under /api):
 *   GET    /v1/connectors            — catalog + connected state
 *   GET    /v1/connectors/:id/status — connected boolean (for polling)
 *   POST   /v1/connectors/:id/connect — store a secret (admin)
 *   DELETE /v1/connectors/:id        — clear a secret (admin)
 */
export function createConnectorsRouter(apiKeys?: ApiKey[], configPath?: string): Router {
  const router = Router();
  if (apiKeys?.length) router.use(createApiAuthMiddleware(apiKeys));

  // Serialise read-modify-write of config.json's gateway.connectors subtree.
  let writeLock: Promise<void> = Promise.resolve();
  async function mutateGatewayConnectors(
    fn: (connectors: Record<string, { secretEnv: string }>) => void,
  ): Promise<void> {
    if (!configPath) return; // no persistence target (e.g. tests) — secret store is authoritative
    const run = writeLock.catch(() => {}).then(async () => {
      const raw = await fsp.readFile(configPath, 'utf-8');
      const config = JSON.parse(raw) as {
        gateway?: { connectors?: Record<string, { secretEnv: string }> };
        [k: string]: unknown;
      };
      config.gateway = config.gateway ?? {};
      config.gateway.connectors = config.gateway.connectors ?? {};
      fn(config.gateway.connectors);
      const tmp = `${configPath}.tmp.${randomUUID()}`;
      await fsp.writeFile(tmp, JSON.stringify(config, null, 2), 'utf-8');
      await fsp.rename(tmp, configPath);
    });
    writeLock = run.catch(() => {});
    return run;
  }

  function requireAdmin(req: Request, res: Response): boolean {
    if (!apiKeys?.length) return true; // no auth configured — allow
    if (!isAdmin((req as AuthedRequest).apiKey)) {
      res.status(403).json({ error: 'Connector management requires an admin API key' });
      return false;
    }
    return true;
  }

  // List catalog + connected state
  router.get('/v1/connectors', (_req: Request, res: Response) => {
    res.json({ connectors: listConnectorStatus() });
  });

  // Single connector status (used by the web to poll)
  router.get('/v1/connectors/:id/status', (req: Request, res: Response) => {
    const spec = getConnectorSpec(req.params.id);
    if (!spec) {
      res.status(404).json({ error: `Unknown connector '${req.params.id}'` });
      return;
    }
    const envName = secretEnvOf(spec);
    const connected = envName === null ? true : hasSecret(envName);
    res.json({ id: spec.id, connected });
  });

  // Connect — store the secret (iteration 1: auth kind 'secret')
  router.post('/v1/connectors/:id/connect', async (req: Request, res: Response) => {
    const spec = getConnectorSpec(req.params.id);
    if (!spec) {
      res.status(404).json({ error: `Unknown connector '${req.params.id}'` });
      return;
    }
    if (!requireAdmin(req, res)) return;

    if (spec.auth.kind === 'none') {
      res.json({ id: spec.id, connected: true });
      return;
    }

    if (spec.auth.kind !== 'secret') {
      res.status(501).json({ error: `Auth kind '${spec.auth.kind}' not yet implemented` });
      return;
    }

    const token = (req.body as { token?: unknown })?.token;
    if (typeof token !== 'string' || !token.trim()) {
      res.status(400).json({ error: 'token is required and must be a non-empty string' });
      return;
    }

    const envName = spec.auth.secretEnv;
    try {
      setSecret(envName, token.trim());
      await mutateGatewayConnectors((c) => {
        c[spec.id] = { secretEnv: envName };
      });
      res.json({ id: spec.id, connected: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Disconnect — clear the secret + wiring
  router.delete('/v1/connectors/:id', async (req: Request, res: Response) => {
    const spec = getConnectorSpec(req.params.id);
    if (!spec) {
      res.status(404).json({ error: `Unknown connector '${req.params.id}'` });
      return;
    }
    if (!requireAdmin(req, res)) return;

    const envName = secretEnvOf(spec);
    try {
      if (envName) deleteSecret(envName);
      await mutateGatewayConnectors((c) => {
        delete c[spec.id];
      });
      res.json({ id: spec.id, connected: false });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
