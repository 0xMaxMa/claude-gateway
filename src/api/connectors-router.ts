import { Router, Request, Response, NextFunction } from 'express';
import { ApiKey, CustomConnectorEntry } from '../types';
import { createApiAuthMiddleware, isAdmin } from './auth';
import { listConnectorStatus, refreshStatusOf } from '../connectors/resolve';
import { setSecret, setSecrets, deleteSecrets, hasSecret, readTokenEnv } from '../connectors/token-env';
import {
  slugify,
  extractPlaceholders,
  customSecretKey,
  isValidConnectorId,
  isReservedPlaceholder,
  isReservedConnectorId,
} from '../connectors/custom';
import { createCustomConnectorsStore, type CustomConnectorsStore } from '../connectors/custom-connectors-store';
import { internalSecretKeysOf } from '../connectors/oauth-refresh-sweep';
import type { AgentRunner } from '../agent/runner';

type AuthedRequest = Request & { apiKey: ApiKey };

/**
 * Connector management API. The gateway acts as connector registry + secret manager
 * + config injector: connecting a connector stores its secret in mcp-token.env —
 * that store alone is authoritative for "connected" (see resolve.ts's
 * listConnectorStatus). The actual MCP server is injected into each session by
 * SessionProcess (see resolveEnabledConnectors).
 *
 * Routes (mounted under /api):
 *   GET    /v1/connectors                    — every connector, with connected state
 *   GET    /v1/connectors/:id/status         — connected boolean (for polling)
 *   POST   /v1/connectors/:id/connect        — store a secret (admin) into a
 *                                              single-secret customConnectors entry
 *                                              (e.g. reconnecting a paste-token
 *                                              connector after DELETE
 *                                              soft-disconnected it) — see the handler
 *   POST   /v1/connectors/:id/oauth/receive  — store a pushed access_token (admin);
 *                                              always writes credentialOwner 'external'
 *   DELETE /v1/connectors/:id                — clear a secret (admin); a 'static' or
 *                                              'gateway' connector keeps its
 *                                              entry (config/label intact, just
 *                                              disconnected), a 'none' or 'external'
 *                                              one is removed outright — see the handler below
 *   POST   /v1/connectors/custom             — add a user-pasted connector (admin)
 *
 * (Removal of a custom connector is NOT a separate route — it's the same
 * DELETE /v1/connectors/:id above. See the note at the bottom of this file for
 * why the old dedicated /custom/:id route was retired.)
 *
 * Externally-owned connectors (Gmail/Drive/Calendar) never do the actual OAuth
 * dance here — an external control plane the deployer runs owns the
 * client_secret, the token exchange, and the refresh loop (this gateway runs
 * inside the user's own VM, reachable by that user's own shell/SSH, so a
 * shared client_secret can't live here safely — see ConnectorCredentialOwner's
 * doc comment). That control plane pushes the resulting short-lived
 * access_token here via /oauth/receive, over the internal network,
 * authenticated the same way any other admin API caller is. A connector this
 * gateway signs in for itself is 'gateway' instead, and lives in
 * oauth-connectors-router.ts.
 *
 * `agents` (all live AgentRunners) is what lets a route that changes a connector's
 * secrets restart the sessions already using it — every route works without it
 * (e.g. in tests), it just leaves running sessions on their stale MCP config
 * until they next respawn on their own.
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

  function requireAdmin(req: Request, res: Response): boolean {
    if (!apiKeys?.length) return true; // no auth configured — allow
    if (!isAdmin((req as AuthedRequest).apiKey)) {
      res.status(403).json({ error: 'Connector management requires an admin API key' });
      return false;
    }
    return true;
  }

  // Every `:id` in this router is used as a config.json object key and interpolated
  // into mcp-token.env key names, so it is validated once here rather than in each
  // handler. /oauth/receive is why this has to be a shape check and not a lookup: it
  // legitimately names a connector that does not exist yet, so there is nothing to
  // validate the id against except its own grammar.
  router.param('id', (req: Request, res: Response, next: NextFunction, id: string) => {
    if (!isValidConnectorId(id)) {
      res.status(400).json({ error: `Invalid connector id '${id}'` });
      return;
    }
    next();
  });

  /**
   * Restart every live session that resolves `id`, after its secrets or its entry
   * changed.
   *
   * A session's MCP subprocess reads its config once, at spawn (see
   * session/process.ts's writeMcpConfig): connecting a connector while a session is
   * running therefore does nothing visible until that session restarts. Without this
   * the web panel flips to "Connected ✓" while the agent the user is talking to still
   * has no such tool, for as long as the session lives.
   *
   * `overlay` carries an entry this route has just written but the config watcher may
   * not have propagated to the runners yet; `force` is for the delete path, which must
   * decide before the secrets are gone (afterwards nothing resolves and the answer is
   * always "no one uses it"). Never throws — a restart failure must not turn a
   * successful connect into a 500.
   */
  async function restartSessionsUsing(
    id: string,
    opts?: { overlay?: Record<string, CustomConnectorEntry>; runners?: AgentRunner[] },
  ): Promise<void> {
    const runners = opts?.runners ?? (agents ? [...agents.values()] : []);
    await Promise.all(
      runners.map((runner) =>
        runner
          .restartSessionsUsingConnector(id, {
            overlay: opts?.overlay,
            force: opts?.runners !== undefined,
          })
          .catch((err: Error) => {
            console.error(`connectors-router: restart for connector=${id} failed: ${err.message}`);
          }),
      ),
    );
  }

  // Every connector, with its connected state.
  //
  // Wrapped because this is an `async` handler and the app runs Express 4, which
  // does not catch a rejected handler promise: it escapes to the process-wide
  // `unhandledRejection` hook in index.ts, which runs emergencyShutdown and
  // exits. A read failure inside this one route therefore used to take down every
  // agent and every channel on the box — and since the web panel polls it, the
  // restarted gateway got killed again on the next poll. Answering 500 keeps the
  // blast radius to the panel that asked.
  router.get('/v1/connectors', async (_req: Request, res: Response) => {
    try {
      res.json({ connectors: listConnectorStatus(await store.read()) });
    } catch (err) {
      console.error(`connectors-router: listing connectors failed: ${(err as Error).message}`);
      res.status(500).json({ error: 'Connector configuration could not be read' });
    }
  });

  // Single connector status (used by the web to poll)
  router.get('/v1/connectors/:id/status', async (req: Request, res: Response) => {
    const custom = (await store.read())[req.params.id];
    if (!custom) {
      res.status(404).json({ error: `Unknown connector '${req.params.id}'` });
      return;
    }
    // One snapshot for both fields. Read separately, `connected` and `refresh`
    // could come from different versions of mcp-token.env — the sweep rewrites
    // it whole — and report a connector as connected with no refresh trouble
    // when in fact the sweep had just cleared its credentials between the reads.
    //
    // Wrapped for the same reason listConnectorStatus wraps each entry:
    // `secretNames` is typed but never validated at read time, and this is an
    // `async` handler on Express 4, which does not catch rejections — an entry
    // missing it would leave the poller's request hanging with no response
    // rather than answering "not connected".
    try {
      const tokenEnv = readTokenEnv();
      const connected = custom.secretNames.every(
        (name: string) => !!tokenEnv[customSecretKey(req.params.id, name)],
      );
      // Same caveat the list endpoint carries: a transiently-failing refresh
      // leaves the (possibly expired) access_token in place, so `connected`
      // alone would keep polling clients green over a dead connector.
      // 'gateway' only, for the reason listConnectorStatus gives: this gateway
      // holds a refresh_token for no other owner, so the sweep never touches
      // them and every counter would read a constant 0.
      const refresh =
        custom.credentialOwner === 'gateway' ? refreshStatusOf(req.params.id, tokenEnv) : undefined;
      res.json({ id: req.params.id, connected, ...(refresh ? { refresh } : {}) });
    } catch (err) {
      console.error(
        `connectors-router: status for connector=${req.params.id} failed: ${(err as Error).message}`,
      );
      res.status(500).json({ error: `Connector '${req.params.id}' has an unreadable configuration` });
    }
  });

  // Connect — store the secret into a customConnectors entry with exactly one
  // secret name. That is what makes reconnecting a paste-token custom connector
  // (e.g. Stripe) actually work after DELETE soft-disconnects it — the entry
  // survives disconnect, so it must be reconnectable here, not only via
  // re-adding it from scratch through POST /v1/connectors/custom.
  router.post('/v1/connectors/:id/connect', async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const id = req.params.id;

    const entry = (await store.read())[id];
    if (!entry) {
      res.status(404).json({ error: `Unknown connector '${id}'` });
      return;
    }
    // Only a 'static' connector has a credential a human is supposed to paste.
    // The other two owners each have their own way in, and naming it is the whole
    // value of this branch — a bare "not allowed here" leaves the caller guessing.
    if (entry.credentialOwner === 'gateway' || entry.credentialOwner === 'external') {
      res.status(400).json({
        error:
          entry.credentialOwner === 'external'
            ? `Connector '${id}' has its credential owned externally — its token is pushed via POST /v1/connectors/${id}/oauth/receive, not set here.`
            : `Connector '${id}' uses OAuth sign-in — start it via POST /v1/connectors/custom/${id}/oauth/start instead`,
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
      await restartSessionsUsing(id, { overlay: { [id]: entry } });
      res.json({ id, connected: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Receive a fresh access_token + full connector shape pushed by an external
  // control plane that owns the sign-in for this connector (github/gmail/
  // google-drive/google-calendar, say) — this is how those connect (and stay
  // fresh on refresh) now. Admin-gated exactly like /connect; the caller is that
  // control plane itself, reaching this over the internal network with the
  // same admin API key any other admin caller would use.
  //
  // The entry is written into gateway.customConnectors — the same storage a
  // user-pasted connector uses — with `credentialOwner: 'external'` recording
  // that the credential is that control plane's to renew, not this gateway's
  // (see ConnectorCredentialOwner). `secretNames` is never trusted from the
  // request body — derived from `config` via extractPlaceholders, the same
  // helper /custom's add route uses, and required to be exactly
  // ['access_token'] (this route only ever manages one pushed secret).
  router.post('/v1/connectors/:id/oauth/receive', async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const id = req.params.id;
    // The one route that takes a connector id verbatim rather than minting it
    // through slugify(), so it is also the only one that can name a server the
    // session writer generates itself — which would silently drop the entry at
    // injection time while every status surface still reported "Connected ✓".
    if (isReservedConnectorId(id)) {
      res.status(400).json({
        error: `Connector id '${id}' is reserved by the gateway's own MCP servers`,
      });
      return;
    }

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
      credentialOwner: 'external',
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
      // can't be hot-patched). The entry is passed as an overlay because the
      // runners' own view of config.json is refreshed by a file watcher that
      // has almost certainly not fired yet for the write just above — on a
      // first push, without it, no runner would consider itself a user of a
      // connector it is about to have.
      await restartSessionsUsing(id, { overlay: { [id]: entry } });

      res.json({ id, connected: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Disconnect — clear the secret + wiring. Checks admin before "does the id
  // exist" (this route used to do it the other way round, which leaked whether
  // an id exists to a non-admin caller).
  router.delete('/v1/connectors/:id', async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const id = req.params.id;

    const existing = await store.read();
    const entry = existing[id];
    if (!entry) {
      res.status(404).json({ error: `Unknown connector '${id}'` });
      return;
    }
    try {
      const usingRunners = agents
        ? [...agents.values()].filter((runner) => runner.usesConnector(id, { [id]: entry }))
        : [];
      const toDelete = entry.secretNames.map((name: string) => customSecretKey(id, name));
      // A 'gateway'-owned entry's refresh_token/client_id/expiry (and any
      // recorded failure backoff, generation counter or cached DCR
      // registration) live outside secretNames — they're sweep-internal
      // bookkeeping, not a {placeholder} from the pasted config (see
      // oauth-refresh-sweep.ts's storage note), so the names above never cover
      // them. Left alone, the still-valid refresh_token would let
      // refreshExpiringOAuthConnectors silently mint a fresh access_token and
      // resurrect a connector the user just disconnected.
      //
      // Enumerated by `internalSecretKeysOf` rather than listed here, because
      // this list drifted: `__dcr_client_id` and `__client_redirect_uri` were
      // added to the OAuth start path and never added to any delete path, so a
      // provider-side registration that had been deleted stayed cached forever.
      // Disconnect-and-reconnect — the one recovery a user can perform from the
      // UI — read the dead client back out, saw its redirect_uri still matched,
      // skipped re-registration, and failed again every time.
      if (entry.credentialOwner === 'gateway') toDelete.push(...internalSecretKeysOf(id));
      deleteSecrets(toDelete);
      // Whether "Disconnect" keeps the entry or removes it follows from who owns
      // the credential, which is the same question as "is there anything here
      // worth preserving for a reconnect".
      //
      // 'static' and 'gateway': the definition IS this entry — the config the
      // user pasted, its label and description exist nowhere else. Wiping it
      // would make Disconnect silently discard all of that, with no way back
      // short of re-adding from scratch. Clear only the secret and leave the row
      // in place as "not connected", so reconnecting costs one paste or one
      // sign-in.
      //
      // 'none': there is no secret to clear. listConnectorStatus's
      // `secretNames.every(...)` is vacuously true on an empty array, so the row
      // would report connected forever no matter what this route did — a
      // soft disconnect is a no-op that looks like a bug (click Disconnect, row
      // stays "Connected"). Nothing to preserve for a reconnect either.
      //
      // 'external': the definition lives in the control plane that pushed it,
      // which the caller can re-push in full via /oauth/receive at any time.
      if (entry.credentialOwner === 'static' || entry.credentialOwner === 'gateway') {
        await restartSessionsUsing(id, { runners: usingRunners });
        res.json({ id, connected: false });
        return;
      }
      await store.mutate((c) => {
        delete c[id];
      });
      // Only on a real delete: the per-agent enablement flags for this id are
      // now orphans, and a later connector that slugs to the same id would
      // inherit them (see removeAgentEnablement's doc). A soft disconnect
      // above keeps the entry, so it keeps its enablement too.
      await store.removeAgentEnablement(id);
      await restartSessionsUsing(id, { runners: usingRunners });
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
    const secretNames = extractPlaceholders(body.config);
    // `__`-prefixed names are the gateway's own (oauth-refresh-sweep.ts). They can no
    // longer collide with it — internalSecretKey() uses a prefix customSecretKey()
    // can't produce — but they would silently resolve to the empty string, so say so.
    const reserved = secretNames.filter(isReservedPlaceholder);
    if (reserved.length) {
      res.status(400).json({
        error: `Placeholder names starting with "__" are reserved by the gateway: ${reserved.join(', ')}`,
      });
      return;
    }
    if (oauth && !secretNames.includes('access_token')) {
      res.status(400).json({
        error:
          'oauth connectors need an {access_token} placeholder in config (e.g. headers.Authorization: "Bearer {access_token}")',
      });
      return;
    }
    // A secret whose name is not a placeholder in `config` can never be read back:
    // resolution only ever looks up `entry.secretNames`. Silently dropping it means
    // the caller pasted a value it believes is stored — a typo in a placeholder name
    // then looks like "the connector just doesn't work", with the real token sitting
    // in a file nothing reads. Report it instead.
    const unknownSecrets = Object.keys(secrets).filter((name) => !secretNames.includes(name));
    if (unknownSecrets.length) {
      res.status(400).json({
        error: `secrets contains ${unknownSecrets.join(', ')}, which ${unknownSecrets.length === 1 ? 'is not a' : 'are not'} {placeholder} in config — expected ${secretNames.length ? secretNames.join(', ') : 'none'}`,
      });
      return;
    }

    try {
      const entry: CustomConnectorEntry = {
        label: body.label.trim(),
        description: typeof body.description === 'string' ? body.description : undefined,
        config: body.config as Record<string, unknown>,
        secretNames,
        sourceUrl:
          typeof body.sourceUrl === 'string' && body.sourceUrl.trim()
            ? body.sourceUrl.trim()
            : undefined,
        // The request field stays `oauth: boolean` — an instruction ("run the
        // sign-in flow on this gateway"), not a report of state, so it has none
        // of the ambiguity the stored flags had. It is resolved to an owner
        // exactly once, here: this route can only ever produce these three.
        // 'external' is written by /oauth/receive alone, because only a caller
        // that already holds a token can claim to own one.
        credentialOwner: oauth ? 'gateway' : secretNames.length ? 'static' : 'none',
      };

      // The id is picked inside the write lock, against the map actually being
      // written. Choosing it from the `read()` above instead left a window in
      // which two concurrent adds of the same label both saw the id as free and
      // the second silently overwrote the first — including pointing it at the
      // first one's already-stored secrets. `store.mutate` is a no-op when there
      // is no config file to persist to (tests), so the pre-computed value below
      // stands in for that case.
      let id = slugify(body.label, Object.keys(existing));
      const label = body.label;
      await store.mutate((c) => {
        id = slugify(label, Object.keys(c));
        c[id] = entry;
      });

      // Secrets go in after the id is final — writing them first would key them
      // to an id the lock might not hand us.
      const values: Record<string, string> = {};
      for (const name of secretNames) {
        const value = secrets[name];
        if (value?.trim()) values[customSecretKey(id, name)] = value.trim();
      }
      if (Object.keys(values).length) setSecrets(values);

      const connected = secretNames.every((name: string) => hasSecret(customSecretKey(id, name)));
      if (connected) await restartSessionsUsing(id, { overlay: { [id]: entry } });
      res.json({ id, label: entry.label, connected });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Custom connector removal is now handled by `DELETE /v1/connectors/:id`
  // above — this used to be a separate `/custom/:id` route; retired in favor
  // of one delete path.

  return router;
}
