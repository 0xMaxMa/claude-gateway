import { Router, Request, Response } from 'express';
import * as fsp from 'fs/promises';
import { randomUUID } from 'crypto';
import { ApiKey, CustomConnectorEntry } from '../types';
import { createApiAuthMiddleware, isAdmin } from './auth';
import { getConnectorSpec } from '../connectors/catalog';
import { listConnectorStatus } from '../connectors/resolve';
import { secretEnvOf } from '../connectors/types';
import { setSecret, deleteSecret, hasSecret } from '../connectors/token-env';
import { slugify, extractPlaceholders, customSecretKey } from '../connectors/custom';
import type { AgentRunner } from '../agent/runner';

type AuthedRequest = Request & { apiKey: ApiKey };

/**
 * Connector management API. The gateway acts as catalog + secret manager + config
 * injector: connecting a connector stores its secret in mcp-token.env and records the
 * non-secret wiring in config.json (gateway.connectors). The actual MCP server is
 * injected into each session by SessionProcess (see resolveEnabledConnectors).
 *
 * Routes (mounted under /api):
 *   GET    /v1/connectors                    — built-in + custom catalog, connected state
 *   GET    /v1/connectors/:id/status         — connected boolean (for polling)
 *   POST   /v1/connectors/:id/connect        — store a secret (admin, auth kind 'secret' only)
 *   POST   /v1/connectors/:id/oauth/receive  — store a pushed access_token (admin, auth kind 'oauth' only)
 *   DELETE /v1/connectors/:id                — clear a secret (admin, built-in only)
 *   POST   /v1/connectors/custom             — add a user-pasted connector (admin)
 *   DELETE /v1/connectors/custom/:id         — remove one (admin)
 *
 * 'oauth'-kind connectors (Gmail/Drive/Calendar) never do the actual OAuth
 * dance here — getpod-ai's services/api owns the client_secret, the token
 * exchange, and the refresh loop (this gateway runs inside the user's own VM,
 * reachable by that user's own shell/SSH, so a shared client_secret can't live
 * here safely — see types.ts's 'oauth' kind doc comment). services/api pushes
 * the resulting short-lived access_token here via /oauth/receive, over the
 * internal network, authenticated the same way any other admin API caller is.
 *
 * `agents` (all live AgentRunners) is only needed so /oauth/receive can
 * restart sessions using the connector — every other route works the same
 * without it (e.g. in tests).
 */
export function createConnectorsRouter(
  apiKeys?: ApiKey[],
  configPath?: string,
  agents?: Map<string, AgentRunner>,
): Router {
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

  // Same read-modify-write-tmp-rename pattern as mutateGatewayConnectors above,
  // targeting gateway.customConnectors instead. Shares the same writeLock so a
  // built-in connect and a custom add can't race each other's read-modify-write.
  async function mutateCustomConnectors(
    fn: (connectors: Record<string, CustomConnectorEntry>) => void,
  ): Promise<void> {
    if (!configPath) return;
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

  /** Fresh read of gateway.customConnectors — mirrors token-env.ts's "no caching" stance. */
  async function readCustomConnectors(): Promise<Record<string, CustomConnectorEntry>> {
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

  function requireAdmin(req: Request, res: Response): boolean {
    if (!apiKeys?.length) return true; // no auth configured — allow
    if (!isAdmin((req as AuthedRequest).apiKey)) {
      res.status(403).json({ error: 'Connector management requires an admin API key' });
      return false;
    }
    return true;
  }

  // List catalog + connected state (built-in + custom)
  router.get('/v1/connectors', async (_req: Request, res: Response) => {
    res.json({ connectors: listConnectorStatus(await readCustomConnectors()) });
  });

  // Single connector status (used by the web to poll) — built-in first, custom fallback
  router.get('/v1/connectors/:id/status', async (req: Request, res: Response) => {
    const spec = getConnectorSpec(req.params.id);
    if (spec) {
      const envName = secretEnvOf(spec);
      const connected = envName === null ? true : hasSecret(envName);
      res.json({ id: spec.id, connected });
      return;
    }

    const custom = (await readCustomConnectors())[req.params.id];
    if (!custom) {
      res.status(404).json({ error: `Unknown connector '${req.params.id}'` });
      return;
    }
    const connected = custom.secretNames.every((name: string) =>
      hasSecret(customSecretKey(req.params.id, name)),
    );
    res.json({ id: req.params.id, connected });
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

    if (spec.auth.kind === 'oauth') {
      res.status(400).json({
        error: `'${spec.id}' is connected via getpod-ai (Google OAuth), not a pasted token`,
      });
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

  // Receive a fresh access_token pushed by getpod-ai's services/api for an
  // 'oauth'-kind connector — this is how Google connectors get connected (and
  // kept fresh on refresh) now. Admin-gated exactly like /connect; the caller
  // is services/api itself, reaching this over the internal network with the
  // same admin API key any other admin caller would use.
  router.post('/v1/connectors/:id/oauth/receive', async (req: Request, res: Response) => {
    const spec = getConnectorSpec(req.params.id);
    if (!spec) {
      res.status(404).json({ error: `Unknown connector '${req.params.id}'` });
      return;
    }
    if (!requireAdmin(req, res)) return;
    if (spec.auth.kind !== 'oauth') {
      res.status(400).json({ error: `'${spec.id}' does not use managed OAuth` });
      return;
    }

    const accessToken = (req.body as { access_token?: unknown })?.access_token;
    if (typeof accessToken !== 'string' || !accessToken.trim()) {
      res.status(400).json({ error: 'access_token is required and must be a non-empty string' });
      return;
    }

    const envName = spec.auth.secretEnv;
    try {
      setSecret(envName, accessToken.trim());
      await mutateGatewayConnectors((c) => {
        c[spec.id] = { secretEnv: envName };
      });

      // A live session already resolved this connector with the stale (or
      // absent) token baked into its MCP subprocess's env — restart it so the
      // next spawn picks up the fresh one (session/process.ts resolves
      // connector secrets fresh on every spawn, but a running subprocess
      // can't be hot-patched).
      if (agents) {
        await Promise.all(
          [...agents.values()].map((runner) => runner.restartSessionsUsingConnector(spec.id)),
        );
      }

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

  // Add a custom (user-pasted) connector — raw mcpServers-entry JSON with
  // {placeholder} tokens standing in for secrets. Admin-trusted, NOT
  // code-reviewed (see CustomConnectorEntry's doc comment for the tradeoff).
  router.post('/v1/connectors/custom', async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;

    const body = req.body as {
      label?: unknown;
      description?: unknown;
      config?: unknown;
      secrets?: unknown;
      sourceUrl?: unknown;
    };

    if (typeof body.label !== 'string' || !body.label.trim()) {
      res.status(400).json({ error: 'label is required and must be a non-empty string' });
      return;
    }
    if (
      typeof body.config !== 'object' ||
      body.config === null ||
      Array.isArray(body.config)
    ) {
      res.status(400).json({ error: 'config is required and must be a JSON object' });
      return;
    }
    if (body.description !== undefined && typeof body.description !== 'string') {
      res.status(400).json({ error: 'description must be a string' });
      return;
    }
    if (body.sourceUrl !== undefined && typeof body.sourceUrl !== 'string') {
      res.status(400).json({ error: 'sourceUrl must be a string' });
      return;
    }
    let secrets: Record<string, string> = {};
    if (body.secrets !== undefined) {
      if (typeof body.secrets !== 'object' || body.secrets === null || Array.isArray(body.secrets)) {
        res.status(400).json({ error: 'secrets must be an object of string values' });
        return;
      }
      for (const v of Object.values(body.secrets as Record<string, unknown>)) {
        if (typeof v !== 'string') {
          res.status(400).json({ error: 'secrets values must all be strings' });
          return;
        }
      }
      secrets = body.secrets as Record<string, string>;
    }

    const existing = await readCustomConnectors();
    const id = slugify(body.label, Object.keys(existing));
    const secretNames = extractPlaceholders(body.config);

    try {
      for (const name of secretNames) {
        const value = secrets[name];
        if (value?.trim()) setSecret(customSecretKey(id, name), value.trim());
      }
      const entry: CustomConnectorEntry = {
        label: body.label.trim(),
        description: typeof body.description === 'string' ? body.description : undefined,
        config: body.config as Record<string, unknown>,
        secretNames,
        sourceUrl:
          typeof body.sourceUrl === 'string' && body.sourceUrl.trim()
            ? body.sourceUrl.trim()
            : undefined,
      };
      await mutateCustomConnectors((c) => {
        c[id] = entry;
      });
      const connected = secretNames.every((name: string) => hasSecret(customSecretKey(id, name)));
      res.json({ id, label: entry.label, connected });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Remove a custom connector — clears its namespaced secrets + config entry.
  router.delete('/v1/connectors/custom/:id', async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;

    const existing = await readCustomConnectors();
    const entry = existing[req.params.id];
    if (!entry) {
      res.status(404).json({ error: `Unknown custom connector '${req.params.id}'` });
      return;
    }

    try {
      for (const name of entry.secretNames) deleteSecret(customSecretKey(req.params.id, name));
      await mutateCustomConnectors((c) => {
        delete c[req.params.id];
      });
      res.json({ id: req.params.id, connected: false });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
