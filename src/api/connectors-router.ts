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
import { createCustomConnectorsStore, type CustomConnectorsStore } from '../connectors/custom-connectors-store';
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
 *   POST   /v1/connectors/:id/connect        — store a secret (admin); built-in catalog
 *                                              first, falls back to a single-secret
 *                                              customConnectors entry (e.g. reconnecting
 *                                              a paste-token connector after DELETE
 *                                              soft-disconnected it) — see the handler
 *   POST   /v1/connectors/:id/oauth/receive  — store a pushed access_token (admin, auth kind 'oauth' only)
 *   DELETE /v1/connectors/:id                — clear a secret (admin); a genuinely
 *                                              user-added custom connector keeps its
 *                                              entry (config/label intact, just
 *                                              disconnected) — see the handler below
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
  customConnectorsStore?: CustomConnectorsStore,
): Router {
  const router = Router();
  if (apiKeys?.length) router.use(createApiAuthMiddleware(apiKeys));
  const store = customConnectorsStore ?? createCustomConnectorsStore(configPath);

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

  // List catalog + connected state (built-in + custom)
  router.get('/v1/connectors', async (_req: Request, res: Response) => {
    res.json({ connectors: listConnectorStatus(await store.read()) });
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

    const custom = (await store.read())[req.params.id];
    if (!custom) {
      res.status(404).json({ error: `Unknown connector '${req.params.id}'` });
      return;
    }
    const connected = custom.secretNames.every((name: string) =>
      hasSecret(customSecretKey(req.params.id, name)),
    );
    res.json({ id: req.params.id, connected });
  });

  // Connect — store the secret. Built-in catalog first (auth kind 'secret'
  // only); falls back to a customConnectors entry with exactly one secret
  // name, same admin-first-then-catalog-then-custom order DELETE already
  // uses below. That fallback is what makes reconnecting a paste-token
  // custom connector (e.g. Stripe) actually work after DELETE soft-disconnects
  // it — the entry survives disconnect, so it must be reconnectable here, not
  // only via re-adding it from scratch through POST /v1/connectors/custom.
  router.post('/v1/connectors/:id/connect', async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const id = req.params.id;

    const spec = getConnectorSpec(id);
    if (spec) {
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
      return;
    }

    const entry = (await store.read())[id];
    if (!entry) {
      res.status(404).json({ error: `Unknown connector '${id}'` });
      return;
    }
    if (entry.oauth) {
      res.status(400).json({
        error: `Connector '${id}' uses OAuth sign-in — start it via POST /v1/connectors/custom/${id}/oauth/start instead`,
      });
      return;
    }
    if (entry.secretNames.length !== 1) {
      res.status(400).json({
        error:
          entry.secretNames.length === 0
            ? `Connector '${id}' has no secrets to set — nothing to connect here.`
            : `Connector '${id}' needs ${entry.secretNames.length} secrets (${entry.secretNames.join(', ')}) — this route only accepts a single value. Remove and re-add it with every value via POST /v1/connectors/custom.`,
      });
      return;
    }

    const token = (req.body as { token?: unknown })?.token;
    if (typeof token !== 'string' || !token.trim()) {
      res.status(400).json({ error: 'token is required and must be a non-empty string' });
      return;
    }
    try {
      setSecret(customSecretKey(id, entry.secretNames[0]), token.trim());
      res.json({ id, connected: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Receive a fresh access_token + full connector shape pushed by getpod-ai's
  // services/api for a GetPod-managed OAuth connector (github/gmail/
  // google-drive/google-calendar) — this is how those connect (and stay fresh
  // on refresh) now. Admin-gated exactly like /connect; the caller is
  // services/api itself, reaching this over the internal network with the
  // same admin API key any other admin caller would use.
  //
  // Unlike /connect, there's no catalog lookup here — CONNECTOR_CATALOG is
  // empty by default, and these ids are never in it (see catalog.ts's doc
  // comment). The entry is written into gateway.customConnectors instead,
  // same storage a user-pasted custom connector uses, with `managed: true` +
  // `authKind: 'oauth'` marking it as services/api's, not the user's (see
  // CustomConnectorEntry's doc comment). `secretNames` is never trusted from
  // the request body — derived from `config` via extractPlaceholders, the
  // same helper /custom's add route uses, and required to be exactly
  // ['access_token'] (this route only ever manages one pushed secret).
  router.post('/v1/connectors/:id/oauth/receive', async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const id = req.params.id;

    const body = req.body as {
      access_token?: unknown;
      label?: unknown;
      description?: unknown;
      config?: unknown;
      sourceUrl?: unknown;
    };

    const accessToken = body?.access_token;
    if (typeof accessToken !== 'string' || !accessToken.trim()) {
      res.status(400).json({ error: 'access_token is required and must be a non-empty string' });
      return;
    }
    if (typeof body.label !== 'string' || !body.label.trim()) {
      res.status(400).json({ error: 'label is required and must be a non-empty string' });
      return;
    }
    if (typeof body.config !== 'object' || body.config === null || Array.isArray(body.config)) {
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

    const placeholders = extractPlaceholders(body.config);
    if (placeholders.length !== 1 || placeholders[0] !== 'access_token') {
      res.status(400).json({
        error: "config must contain exactly one {access_token} placeholder and no others",
      });
      return;
    }

    const entry: CustomConnectorEntry = {
      label: body.label.trim(),
      description: typeof body.description === 'string' ? body.description : undefined,
      config: body.config as Record<string, unknown>,
      secretNames: ['access_token'],
      sourceUrl:
        typeof body.sourceUrl === 'string' && body.sourceUrl.trim()
          ? body.sourceUrl.trim()
          : undefined,
      authKind: 'oauth',
      managed: true,
    };

    try {
      setSecret(customSecretKey(id, 'access_token'), accessToken.trim());
      await store.mutate((c) => {
        c[id] = entry;
      });

      // A live session already resolved this connector with the stale (or
      // absent) token baked into its MCP subprocess's env — restart it so the
      // next spawn picks up the fresh one (session/process.ts resolves
      // connector secrets fresh on every spawn, but a running subprocess
      // can't be hot-patched).
      if (agents) {
        await Promise.all(
          [...agents.values()].map((runner) => runner.restartSessionsUsingConnector(id)),
        );
      }

      res.json({ id, connected: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Disconnect — clear the secret + wiring. Unified across built-in (catalog)
  // and custom/managed (customConnectors) storage: checks admin first (this
  // route used to check "does the id exist" before "is the caller admin" —
  // unifying with the custom-delete logic below means picking one order, and
  // admin-first doesn't leak whether an id exists to a non-admin caller),
  // then tries the catalog, then falls back to customConnectors instead of
  // 404ing — github/gmail/etc. live there now (see /oauth/receive above), and
  // this used to be a 404 dead-end for them before this fallback existed.
  router.delete('/v1/connectors/:id', async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const id = req.params.id;

    const spec = getConnectorSpec(id);
    if (spec) {
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
      return;
    }

    const existing = await store.read();
    const entry = existing[id];
    if (!entry) {
      res.status(404).json({ error: `Unknown connector '${id}'` });
      return;
    }
    try {
      for (const name of entry.secretNames) deleteSecret(customSecretKey(id, name));
      // A genuinely user-added custom connector (not entry.managed) has no
      // catalog to fall back on — its config/label/description IS the
      // customConnectors entry, so wiping the whole entry here used to mean
      // "Disconnect" silently discarded everything the user pasted, with no
      // way back short of re-adding it from scratch. Clearing only the
      // secret (leaving the entry, and thus the row, in place as "not
      // connected") lets the user reconnect without retyping the config.
      // Managed entries (github/gmail/etc., pushed by services/api) keep the
      // old delete-the-entry behavior: their definition lives in the
      // services/api-owned managed catalog instead, which the web panel
      // already falls back to for the "not connected" row, and reconnecting
      // re-pushes a full entry via /oauth/receive regardless.
      if (!entry.managed) {
        res.json({ id, connected: false });
        return;
      }
      await store.mutate((c) => {
        delete c[id];
      });
      res.json({ id, connected: false });
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
      oauth?: unknown;
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
    if (body.oauth !== undefined && typeof body.oauth !== 'boolean') {
      res.status(400).json({ error: 'oauth must be a boolean' });
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

    const oauth = body.oauth === true;
    if (oauth && typeof (body.config as { url?: unknown }).url !== 'string') {
      res.status(400).json({ error: 'config.url is required when oauth is true' });
      return;
    }

    const existing = await store.read();
    const id = slugify(body.label, Object.keys(existing));
    const secretNames = extractPlaceholders(body.config);
    if (oauth && !secretNames.includes('access_token')) {
      res.status(400).json({
        error:
          'oauth connectors need an {access_token} placeholder in config (e.g. headers.Authorization: "Bearer {access_token}")',
      });
      return;
    }

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
        oauth: oauth || undefined,
      };
      await store.mutate((c) => {
        c[id] = entry;
      });
      const connected = secretNames.every((name: string) => hasSecret(customSecretKey(id, name)));
      res.json({ id, label: entry.label, connected });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Custom connector removal is now handled by the unified
  // `DELETE /v1/connectors/:id` above (falls back to customConnectors when
  // the id isn't a built-in catalog entry) — this used to be a separate
  // `/custom/:id` route; retired in favor of one delete path for both.

  return router;
}
