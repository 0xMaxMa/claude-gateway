import { Router, Request, Response, NextFunction } from 'express';
import { ApiKey, CustomConnectorEntry } from '../types';
import { createApiAuthMiddleware, isAdmin } from './auth';
import { listConnectorStatus, refreshStatusOf } from '../connectors/resolve';
import {
  setSecret,
  setSecrets,
  deleteSecrets,
  updateSecrets,
  hasSecret,
  readTokenEnv,
} from '../connectors/token-env';
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
   * a status poller flips to "connected" while the agent the user is talking to still
   * has no such tool, for as long as the session lives.
   *
   * `overlay` carries an entry this route has just written but the config watcher may
   * not have propagated to the runners yet. Never throws — a restart failure must not
   * turn a successful connect into a 500.
   *
   * Called on the delete paths too, after the secrets are gone: "this connector now
   * resolves to nothing" is itself the change each session is compared against (see
   * AgentRunner.restartSessionsUsingConnector). The hard-delete branch passes
   * `{ [id]: null }`, the overlay's way of saying the entry was removed — a
   * `'none'`-owner connector has no secrets whose absence would signal the change on
   * its own, so against the runners' not-yet-refreshed config snapshot it would
   * otherwise still resolve identically and nothing would restart.
   */
  async function restartSessionsUsing(
    id: string,
    opts?: { overlay?: Record<string, CustomConnectorEntry | null> },
  ): Promise<void> {
    await Promise.all(
      (agents ? [...agents.values()] : []).map((runner) =>
        runner
          .restartSessionsUsingConnector(id, { overlay: opts?.overlay })
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
  // agent and every channel on the box — and since callers poll this route, the
  // restarted gateway got killed again on the next poll. Answering 500 keeps the
  // blast radius to the client that asked.
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

    // Body validation happens inside the locked callback below, in the position it
    // always had — after the entry checks, so an unknown id still answers 404 rather
    // than "token is required". It is pure CPU, so it costs the lock nothing.
    const token = (req.body as { token?: unknown })?.token;

    // Everything below, validation included, sits inside the try. `withEntry`
    // does no shape validation — `secretNames` is required by the TypeScript type
    // and by nothing at runtime — so an entry hand-written into config.json
    // without it turns the checks below into a TypeError, and on Express 4 a
    // rejected async handler escapes to index.ts's `unhandledRejection` hook,
    // which calls emergencyShutdown(). The read paths were already hardened for
    // exactly this (see token-env.ts and custom-connectors-store.ts); a
    // malformed entry must cost the caller a 500, not every agent on the box.
    try {
      // `withEntry`, not `read()`: the entry decides both whether a pasted token
      // belongs here and WHICH secret name it is filed under, and /oauth/receive
      // rewrites exactly those two fields on an existing id. Read outside the lock,
      // a push landing in between left this route storing the token under a name
      // the entry no longer declares — nothing ever reads it back, and no route
      // clears it either, since every delete path enumerates the CURRENT
      // secretNames. Deciding inside the lock makes that ordering impossible.
      const outcome = await store.withEntry(id, ({ entry }) => {
        if (!entry) return { status: 404, error: `Unknown connector '${id}'` } as const;
        // Only a 'static' connector has a credential a human is supposed to paste.
        // The other two owners each have their own way in, and naming it is the whole
        // value of this branch — a bare "not allowed here" leaves the caller guessing.
        if (entry.credentialOwner === 'gateway' || entry.credentialOwner === 'external') {
          return {
            status: 400,
            error:
              entry.credentialOwner === 'external'
                ? `Connector '${id}' has its credential owned externally — its token is pushed via POST /v1/connectors/${id}/oauth/receive, not set here.`
                : `Connector '${id}' uses OAuth sign-in — start it via POST /v1/connectors/custom/${id}/oauth/start instead`,
          } as const;
        }
        if (entry.secretNames.length !== 1) {
          return {
            status: 400,
            error:
              entry.secretNames.length === 0
                ? `Connector '${id}' has no secrets to set — nothing to connect here.`
                : `Connector '${id}' needs ${entry.secretNames.length} secrets (${entry.secretNames.join(', ')}) — this route only accepts a single value. Remove and re-add it with every value via POST /v1/connectors/custom.`,
          } as const;
        }
        if (typeof token !== 'string' || !token.trim()) {
          return { status: 400, error: 'token is required and must be a non-empty string' } as const;
        }
        setSecret(customSecretKey(id, entry.secretNames[0]), token.trim());
        return { status: 200, entry } as const;
      });
      if (outcome.status !== 200) {
        res.status(outcome.status).json({ error: outcome.error });
        return;
      }
      // Outside the lock: restarting sessions is slow, needs nothing from the
      // entry beyond the copy taken above, and a runner that rewrites config.json
      // while we still held it would deadlock (see withEntry's doc).
      await restartSessionsUsing(id, { overlay: { [id]: outcome.entry } });
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

    // This route always writes credentialOwner 'external', so pushing onto an id
    // that was 'gateway'-owned is a handover: from here on nothing refreshes it —
    // the sweep only ever acts on 'gateway' entries — and DELETE only clears the
    // sweep's internal keys under that same `credentialOwner === 'gateway'` guard,
    // which no longer holds. The refresh_token, cached DCR client_id and failure
    // bookkeeping left behind would therefore outlive every path that could remove
    // them, sitting in mcp-token.env as a live credential belonging to a grant the
    // gateway has stopped managing. Cleared here, in the same write that stores the
    // pushed token, so the handover is atomic rather than a two-step that can be
    // interrupted between halves.
    //
    // The same argument applies to the previous entry's OWN secrets, under names
    // this route does not reuse: it overwrites `secretNames` with ['access_token'],
    // and every path that could remove a custom secret enumerates the CURRENT
    // secretNames — DELETE maps over them, /connect is closed to 'external'. A
    // 'static' connector's pasted `{api_key}` would sit in the 0600 store as a live
    // third-party key with no supported operation left that clears it.
    // Captured INSIDE store.mutate, not from a `read()` before it. The two are
    // the same value only if nothing writes config.json in between, and the
    // whole reason `mutate` exists is that things do: an unlocked read here
    // races the entry this very route is about to overwrite. Lose that race —
    // an admin completes a browser sign-in on this id, or /connect stores a
    // pasted token, between the read and the locked write — and `previousOwner`
    // says 'static' for an entry that is now 'gateway'-owned, so the
    // internalSecretKeysOf() removal below is skipped and the fresh
    // refresh_token survives a handover to 'external'. Nothing collects it
    // afterwards: the sweep ignores non-'gateway' entries and DELETE clears
    // internal keys only under that same guard, leaving a live credential in
    // mcp-token.env for a grant this gateway no longer manages — precisely the
    // orphan the comment above exists to prevent. `mutate` reads the file under
    // the write lock, so the entry it hands us is the one being replaced.
    //
    // Left at their defaults when there is no persistence target (tests), where
    // `mutate` returns before invoking this callback — same as the `read()` that
    // returned {} there.
    let previousOwner: string | undefined;
    let staleSecretKeys: string[] = [];

    try {
      // config.json first, secrets second — matching the /custom add route below.
      // If the second write fails, `listConnectorStatus` finds no secret and reports
      // the row disconnected, which is honest and re-pushable. The other order
      // fails to an orphaned secret under an id that DELETE 404s on, so nothing
      // can ever clear it.
      await store.mutate((c) => {
        const previous = c[id];
        previousOwner = previous?.credentialOwner;
        staleSecretKeys = (previous?.secretNames ?? [])
          .filter((name: string) => !entry.secretNames.includes(name))
          .map((name: string) => customSecretKey(id, name));
        c[id] = entry;
      });
      updateSecrets({ [customSecretKey(id, 'access_token')]: accessToken.trim() }, [
        ...staleSecretKeys,
        ...(previousOwner === 'gateway' ? internalSecretKeysOf(id) : []),
      ]);

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

    try {
      // `withEntry`, not `read()`. Every decision this route makes comes off the
      // entry — `credentialOwner` picks soft-disconnect vs hard-delete AND whether
      // the sweep's internal keys are cleared, `secretNames` picks which of its own
      // secrets go — and /oauth/receive rewrites all three of those fields on an
      // existing id in a single locked write. Read outside the lock, a push landing
      // in between left this route clearing secrets under names the entry no longer
      // declares, skipping the internal-key removal for an owner that had just
      // stopped being 'gateway' (or performing it for one that had just become
      // 'external'), and keeping an entry whose new owner says remove it. Every one
      // of those leaves a live credential in mcp-token.env that no later route can
      // reach. Deciding inside the lock is what /oauth/receive itself was fixed to
      // do; this is the other side of the same race.
      const outcome = await store.withEntry(id, ({ entry, remove }) => {
        if (!entry) return { found: false } as const;
        // Which of the entry's own secrets Disconnect clears depends on which of
        // them a reconnect can put back.
        //
        // 'gateway': only `access_token` is the gateway's to mint — the OAuth
        // callback writes that one key and nothing else from `secretNames` (see
        // oauth-connectors-router.ts's updateSecrets call). Any OTHER placeholder
        // on a `oauth: true` connector — a `{workspace_id}`, a `{team_domain}` —
        // came from the `secrets` map pasted into POST /v1/connectors/custom, and
        // no route can restore it: /connect is closed to 'gateway' owners and the
        // add route mints a NEW id via slugify(). Clearing them all therefore made
        // one Disconnect permanent for any multi-placeholder OAuth connector —
        // sign-in succeeded, `secretNames.every(hasSecret)` stayed false because of
        // the placeholder nothing had refilled, and the row read "Not connected"
        // forever with no recovery short of hand-editing config.json. Only the
        // credential the user asked to revoke is cleared; the rest is inert
        // configuration that costs nothing to keep and is the difference between
        // "reconnect is one sign-in" and "remove and re-add from scratch".
        //
        // Every other owner: `secretNames` is exactly what a reconnect re-supplies
        // (one /connect paste for 'static', one /oauth/receive push for
        // 'external', nothing at all for 'none'), so all of it goes.
        const toDelete =
          entry.credentialOwner === 'gateway'
            ? [customSecretKey(id, 'access_token')]
            : entry.secretNames.map((name: string) => customSecretKey(id, name));
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
          return { found: true, hard: false } as const;
        }
        // The entry AND the per-agent enablement flags that reference it, in this
        // one locked write: with the entry gone nothing would ever come back for
        // orphaned flags, so splitting this in two would reintroduce exactly the
        // orphan it exists to prevent (see dropConnector's doc). A soft
        // disconnect above keeps the entry, so it keeps its enablement too.
        remove();
        return { found: true, hard: true } as const;
      });
      if (!outcome.found) {
        res.status(404).json({ error: `Unknown connector '${id}'` });
        return;
      }
      // `null` is the overlay's way of saying "this entry is gone", and the
      // hard-delete branch is the one place that needs it. A 'none'-owner
      // connector has no secret whose disappearance would change its resolved
      // shape, and the runners' config snapshot is refreshed by a file watcher
      // that has almost certainly not fired for the write above — so without the
      // overlay every session's spawn-time fingerprint still matches, nothing
      // restarts, and agents keep talking to a connector the API has just
      // reported deleted until something unrelated restarts them.
      //
      // After the lock, not inside it: a restart can take seconds, and a runner
      // that rewrites config.json on the way would deadlock against it.
      await restartSessionsUsing(id, outcome.hard ? { overlay: { [id]: null } } : undefined);
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
    if (oauth && secrets.access_token !== undefined) {
      // A pasted access_token on a connector that says "the gateway signs this in"
      // is a state nothing here can maintain. `oauth: true` makes the entry
      // 'gateway'-owned, and the refresh sweep renews a 'gateway' token from the
      // refresh_token the sign-in stores — which a paste cannot supply, since the
      // gateway never saw the exchange it came out of.
      //
      // Accepted, the row read "connected" off `secretNames.every(hasSecret)`
      // immediately and stayed that way: the sweep skips a connector with no
      // refresh_token, so it records no failure, and `unrefreshable` could not
      // catch it either because it keyed on a stored expiry that only a real
      // sign-in ever writes. The connector then simply stopped working whenever
      // the pasted token aged out, with a green checkmark still on it and nothing
      // in any log — the exact state oauth-refresh-sweep.ts's module comment says
      // it exists to prevent.
      //
      // Both real intents remain reachable: sign in through /oauth/start, or
      // re-send this request without `oauth` to get a 'static' connector, which is
      // what a hand-held token actually is. Other placeholders on an oauth
      // connector are untouched — a {workspace_id} is inert configuration the
      // sign-in neither writes nor can supply.
      res.status(400).json({
        error:
          'access_token cannot be pasted into an oauth connector — the gateway mints it at' +
          ' POST /v1/connectors/custom/:id/oauth/start and needs the refresh_token from that' +
          ' exchange to keep it alive. Omit `oauth` to store a hand-held token as a static' +
          ' connector instead.',
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
