/**
 * Periodic refresh for connectors whose credential this gateway owns
 * (CustomConnectorEntry.credentialOwner === 'gateway') — the gateway-side
 * counterpart to whatever refresh loop an external control plane runs for the
 * 'external' entries it pushes in. Runs on the same 60s
 * interval as cliPairingStore.prune() (see gateway-router.ts) via
 * refreshExpiringOAuthConnectors().
 *
 * Storage note: the refresh_token, its client_id, the access_token expiry and this
 * sweep's failure bookkeeping all live in the same mcp-token.env as connector secrets,
 * but under `internalSecretKey()`'s `CUSTOMINT__` prefix, which `customSecretKey()`
 * cannot produce. `PLACEHOLDER_RE` accepts a leading underscore, so it is the prefix —
 * not the `__` naming convention — that keeps a pasted `{__refresh_token}` from
 * resolving to this sweep's slot. See custom.ts's `internalSecretKey`.
 */

import type { AgentRunner } from '../agent/runner';
import type { CustomConnectorsStore } from './custom-connectors-store';
import { customSecretKey, internalSecretKey } from './custom';
import {
  getSecret,
  getSecretFrom,
  parseCounter,
  readTokenEnv,
  setSecrets,
  updateSecrets,
  deleteSecrets,
} from './token-env';
import { discoverOAuthMetadataCached, refreshAccessToken, OAuthTokenError } from './mcp-oauth';

const REFRESH_SKEW_MS = 5 * 60 * 1000;
// Base wait after a failed refresh. Without it, a permanently-broken refresh_token
// (a blip self-heals next tick; a revoked one never will) is hammered every 60s.
const REFRESH_BACKOFF_MS = 5 * 60 * 1000;
// Ceiling for the transient-failure backoff. A connector whose MCP URL is gone for
// good never produces an RFC 6749 error, so it can never reach the permanent
// give-up — it just fails transiently forever. A flat REFRESH_BACKOFF_MS would
// retry (and log) every five minutes for the life of the process; backing off
// exponentially to this cap makes that four attempts a day, while still recovering
// on its own the moment the provider comes back.
const MAX_REFRESH_BACKOFF_MS = 6 * 60 * 60 * 1000;
// Consecutive failures before giving up entirely: clear the tokens so status flips
// to "not connected" instead of an indefinitely-retrying green checkmark.
//
// Only failures the authorization server itself declared count (see
// OAuthTokenError.isPermanent). Giving up deletes the user's credentials, and an
// unreachable provider says nothing about whether the grant is still good —
// counting those meant a routine outage landing inside a token's refresh window
// silently destroyed a working sign-in. Transient failures back off instead, and
// are counted separately so status can show "still retrying".
const MAX_CONSECUTIVE_FAILURES = 3;

/** Backoff for the nth consecutive transient failure, capped. */
export function transientBackoffMs(consecutiveFailures: number): number {
  const n = Math.max(1, consecutiveFailures);
  // 2 ** n overflows to Infinity long before this matters, and Infinity * x is still
  // Infinity — clamp the exponent, not just the product.
  const exponent = Math.min(n - 1, 32);
  return Math.min(REFRESH_BACKOFF_MS * 2 ** exponent, MAX_REFRESH_BACKOFF_MS);
}

/** A failure counter read fresh out of mcp-token.env, floored by `parseCounter`. Used
 *  only in the failure branches, which read-modify-write the counter after the network
 *  round trip — the due-check up front reads from one snapshot instead. */
function readCounter(key: string): number {
  return parseCounter(getSecret(key));
}

export function refreshTokenSecretKey(id: string): string {
  return internalSecretKey(id, '__refresh_token');
}
export function clientIdSecretKey(id: string): string {
  return internalSecretKey(id, '__client_id');
}
export function expiresAtSecretKey(id: string): string {
  return internalSecretKey(id, '__token_expires_at');
}
export function refreshFailCountSecretKey(id: string): string {
  return internalSecretKey(id, '__refresh_fail_count');
}
export function refreshBackoffUntilSecretKey(id: string): string {
  return internalSecretKey(id, '__refresh_backoff_until');
}
/** Consecutive *transient* failures — kept apart from `__refresh_fail_count` so an
 *  outage can never accumulate toward deleting a live grant. Drives the exponential
 *  backoff and status's `refresh` block; cleared on the first success. */
export function refreshTransientCountSecretKey(id: string): string {
  return internalSecretKey(id, '__refresh_transient_count');
}
/** Bumped on every access_token write — by the OAuth callback on a fresh sign-in
 *  AND by this sweep on a successful refresh. Read back before this sweep commits,
 *  so a manual reconnect landing mid-refresh wins instead of being clobbered by a
 *  slower, now-stale refresh. */
export function tokenGenerationSecretKey(id: string): string {
  return internalSecretKey(id, '__token_generation');
}

/**
 * DCR registration cache — deliberately NOT `clientIdSecretKey`.
 *
 * `oauth/start` registers a client before the user has done anything, and the flow can
 * be abandoned. Writing that client_id into the key this sweep reads left the connector
 * pairing refresh_token R1 (issued to the OLD client C1) with client_id C2; the next
 * refresh POSTs that mismatched pair, the AS answers `invalid_client` — permanent, and
 * correctly so for that pair — and three ticks later a working sign-in is deleted
 * because an admin opened a Connect dialog and closed it again.
 *
 * `clientIdSecretKey` is written only by the callback, i.e. only once a token has
 * actually been issued to that client. This key is just a cache so retried Connect
 * clicks don't orphan a fresh registration at the provider every attempt. It lives
 * beside the keys the sweep owns because the give-up path and DELETE /v1/connectors/:id
 * both have to invalidate it (see `clearsDcrRegistration`).
 */
export function dcrClientIdSecretKey(id: string): string {
  return internalSecretKey(id, '__dcr_client_id');
}

/** The redirect_uri `dcrClientIdSecretKey`'s cached client was registered with. Reuse
 *  that client_id only while this matches the current callback URL — otherwise the
 *  provider would reject it, so re-registering is correct, not a skipped optimization. */
export function clientRedirectUriSecretKey(id: string): string {
  return internalSecretKey(id, '__client_redirect_uri');
}

/** Every key this sweep and the OAuth routers store for one connector, for the paths
 *  that clear a connector out entirely. Enumerated once so a new key cannot be added to
 *  the writers and forgotten by the deleters — the bug that left dead DCR registrations
 *  behind forever. `includeDcrRegistration: false` keeps the cached DCR client (see
 *  `clearsDcrRegistration`). */
export function internalSecretKeysOf(
  id: string,
  opts: { includeDcrRegistration?: boolean } = {},
): string[] {
  const { includeDcrRegistration = true } = opts;
  return [
    refreshTokenSecretKey(id),
    clientIdSecretKey(id),
    expiresAtSecretKey(id),
    refreshFailCountSecretKey(id),
    refreshBackoffUntilSecretKey(id),
    refreshTransientCountSecretKey(id),
    // Cleared with the rest: a generation left behind for a token-less id means the
    // next sign-in starts from a value a still-running refresh may already have read,
    // and the optimistic-concurrency check silently stops guarding.
    tokenGenerationSecretKey(id),
    ...(includeDcrRegistration ? [dcrClientIdSecretKey(id), clientRedirectUriSecretKey(id)] : []),
  ];
}

/**
 * Whether a give-up should also drop the cached DCR registration.
 *
 * Not on every give-up. `invalid_grant` means the refresh_token is dead while the
 * registered client is still good — dropping it orphans a registration for nothing.
 * `invalid_client`/`unauthorized_client` is the opposite: the provider does not
 * recognise the client at all, and a cache holding a deleted client_id is
 * unrecoverable through the UI — Connect finds the redirect_uri still matching,
 * skips re-registration and fails again forever.
 */
function clearsDcrRegistration(err: unknown): boolean {
  return (
    err instanceof OAuthTokenError &&
    (err.errorCode === 'invalid_client' || err.errorCode === 'unauthorized_client')
  );
}

/**
 * Guards against overlapping sweeps. The caller (gateway-router.ts) fires this on a
 * fixed 60s interval without awaiting it, so a slow token endpoint leaves a sweep in
 * flight when the next tick starts. Both would read the same `__refresh_token` and POST
 * it; against a provider that rotates refresh tokens (the OAuth 2.1 default for a
 * public client) the second use is replay, and the whole grant is revoked.
 *
 * A plain boolean suffices: one process-wide job, and skipping a tick is free — the
 * next is 60s away and the work is idempotent.
 */
let sweepInFlight = false;

/**
 * Scan every gateway-owned connector; refresh any whose access_token is within
 * REFRESH_SKEW_MS of its recorded expiry. Best-effort per connector — a failure is
 * logged and skipped, never thrown, so one broken connector can't stop the rest.
 * `agents` lets a successful refresh restart sessions already using the connector (a
 * live MCP subprocess has the OLD token baked in and can't be hot-patched).
 */
export async function refreshExpiringOAuthConnectors(
  store: CustomConnectorsStore,
  agents?: Map<string, AgentRunner>,
): Promise<void> {
  if (sweepInFlight) return; // previous tick still running — see sweepInFlight
  sweepInFlight = true;
  try {
    await sweepOnce(store, agents);
  } finally {
    sweepInFlight = false; // released even if a connector loop threw
  }
}

async function sweepOnce(
  store: CustomConnectorsStore,
  agents?: Map<string, AgentRunner>,
): Promise<void> {
  const connectors = await store.read();
  for (const [id, entry] of Object.entries(connectors)) {
    // Only 'gateway': this sweep refreshes with a refresh_token THIS gateway
    // holds, and it holds one for no other owner. An 'external' entry is the
    // control plane's to renew.
    if (entry.credentialOwner !== 'gateway') continue;
    try {
      await refreshOne(id, entry, agents);
    } catch (err) {
      // The per-connector guard, around the WHOLE step rather than the network call
      // alone: `refreshOne`'s own try/catch covers the refresh, but the getSecret
      // reads deciding whether it is due and the updateSecrets/deleteSecrets in its
      // failure branches all touch mcp-token.env and can throw an errno. Uncaught,
      // one blip on the first connector abandoned the sweep for every connector
      // after it, with gateway-router.ts's `.catch()` swallowing the reason.
      console.error(
        `oauth-refresh-sweep: connector=${id} sweep step failed: ${(err as Error).message}`,
      );
    }
  }
}

async function refreshOne(
  id: string,
  entry: { config: Record<string, unknown> },
  agents?: Map<string, AgentRunner>,
): Promise<void> {
  // One read+parse of mcp-token.env for the whole due-check. Every value below is
  // answering the same question at the same instant, and there is no await between
  // them, so five separate getSecret() calls were five reads of one file per connector
  // per tick with no added freshness — the read pattern listConnectorStatus already
  // uses. (The generation re-read AFTER the network round trip is a different thing
  // entirely and stays a fresh read — see below.)
  const secrets = readTokenEnv();

  const backoffUntilRaw = getSecretFrom(secrets, refreshBackoffUntilSecretKey(id));
  if (backoffUntilRaw && Number(backoffUntilRaw) > Date.now()) return; // recent failure — still backing off

  // An absent, non-numeric or infinite expiry falls through to a refresh rather than
  // "not due yet". Refreshing on an unknown expiry costs one round trip and
  // self-corrects (the success path always writes a fresh expiry); trusting a corrupt
  // one — Infinity reads as "expires never" — silently never refreshes at all.
  const expiresAt = Number(getSecretFrom(secrets, expiresAtSecretKey(id)) ?? '');
  if (Number.isFinite(expiresAt) && expiresAt - Date.now() >= REFRESH_SKEW_MS) return; // not due yet

  const refreshToken = getSecretFrom(secrets, refreshTokenSecretKey(id));
  const clientId = getSecretFrom(secrets, clientIdSecretKey(id));
  const mcpUrl = typeof entry.config.url === 'string' ? entry.config.url : null;
  // Nothing to refresh with (disconnected, or a provider that issued no
  // refresh_token). Skipped silently, and no failure recorded — nothing failed.
  // `refreshStatusOf` surfaces this instead, deriving `unrefreshable` from an expired
  // access_token with no refresh_token beside it.
  if (!refreshToken || !clientId || !mcpUrl) return;

  // Captured before the two network round-trips so a concurrent manual reconnect (a
  // fresh /oauth/mcp/callback exchange racing this refresh) is detected before this
  // sweep commits a write derived from a now-stale refresh_token. Taken from the same
  // snapshot as the values above — it is the "before" side of the comparison, read
  // synchronously alongside them; it is the "after" side that must hit the file again.
  const generationBefore = getSecretFrom(secrets, tokenGenerationSecretKey(id));

  try {
    const metadata = await discoverOAuthMetadataCached(mcpUrl);
    const token = await refreshAccessToken({ metadata, clientId, refreshToken });

    if (getSecret(tokenGenerationSecretKey(id)) !== generationBefore) {
      // A manual reconnect wrote a newer token mid-flight — strictly fresher than
      // this one, so abandon ours. Not a failure: leave the backoff/counters alone.
      return;
    }

    // One rewrite for the whole result: a crash between separate writes could file a
    // new access_token under the OLD expiry (read as "already due" every tick after),
    // or leave a fresh token carrying a stale backoff.
    updateSecrets(
      {
        [customSecretKey(id, 'access_token')]: token.access_token,
        ...(token.refresh_token ? { [refreshTokenSecretKey(id)]: token.refresh_token } : {}),
        [expiresAtSecretKey(id)]: String(Date.now() + (token.expires_in ?? 3600) * 1000),
        [tokenGenerationSecretKey(id)]: String(Date.now()),
      },
      [
        refreshFailCountSecretKey(id),
        refreshBackoffUntilSecretKey(id),
        refreshTransientCountSecretKey(id),
      ],
    );

    if (agents) {
      await Promise.all(
        [...agents.values()].map((runner) =>
          // Guarded per runner, as the two routers guard their own restarts.
          // Unguarded, a rejecting `proc.stop()` fell into the catch below — which
          // treats any non-OAuthTokenError as a transient *refresh* failure — so an
          // already-succeeded refresh got logged as failed, backed off, and counted
          // toward the transient streak.
          runner.restartSessionsUsingConnector(id).catch((e: Error) => {
            console.error(`oauth-refresh-sweep: restart for connector=${id} failed: ${e.message}`);
          }),
        ),
      );
    }
  } catch (err) {
    // Only an explicit refusal from the authorization server counts toward giving up.
    // DNS, timeouts, a 502, a malformed discovery response — all mean the provider is
    // unreachable, which says nothing about whether the grant is still valid.
    const permanent = err instanceof OAuthTokenError && err.isPermanent;
    const failCount = permanent ? readCounter(refreshFailCountSecretKey(id)) + 1 : 0;
    const transientCount = permanent
      ? 0 // the AS answered, so it is reachable — the transient streak is over
      : readCounter(refreshTransientCountSecretKey(id)) + 1;
    const backoffMs = permanent ? REFRESH_BACKOFF_MS : transientBackoffMs(transientCount);
    // Decided before the log line: this branch deletes the user's credentials, and a
    // "retrying in 5m" printed immediately above that deletion is the one message an
    // admin reads while working out why a connector dropped.
    const givingUp = permanent && failCount >= MAX_CONSECUTIVE_FAILURES;

    console.error(
      `oauth-refresh-sweep: connector=${id} refresh failed` +
        ` (${permanent ? `permanent, attempt ${failCount}` : `transient, attempt ${transientCount}`};` +
        ` ${
          givingUp
            ? 'giving up — clearing stored credentials'
            : `retrying in ${Math.round(backoffMs / 60000)}m`
        }): ${(err as Error).message}`,
    );

    if (givingUp) {
      // The AS refused this grant this many times in a row — it is not coming back on
      // its own. Clear everything so status reports "not connected" and this loop
      // stops calling a dead token endpoint on every future tick.
      deleteSecrets([
        customSecretKey(id, 'access_token'),
        ...internalSecretKeysOf(id, { includeDcrRegistration: clearsDcrRegistration(err) }),
      ]);
      // …and restart, for the same reason the success path above does and the
      // unified DELETE route does. A live session's MCP subprocess was spawned with
      // the token just deleted baked into its env and cannot be hot-patched, so
      // without this it keeps advertising the connector's tools and failing every
      // call against them with a 401 the model has no way to interpret. Respawned,
      // the connector resolves with no secret, session/process.ts leaves it out of
      // the MCP config, and the tools are simply absent — which is the truth.
      //
      // Guarded per runner for the reason spelled out on the success path: an
      // unguarded rejection lands in this same catch block and would be re-counted
      // as a refresh failure.
      if (agents) {
        await Promise.all(
          [...agents.values()].map((runner) =>
            runner.restartSessionsUsingConnector(id).catch((e: Error) => {
              console.error(
                `oauth-refresh-sweep: restart after give-up for connector=${id} failed: ${e.message}`,
              );
            }),
          ),
        );
      }
    } else if (permanent) {
      // One rewrite, same reason as the success path: splitting the new permanent
      // count from the cleared transient one left a window where both were set,
      // which status renders as a transient backoff that no longer exists.
      updateSecrets(
        {
          [refreshFailCountSecretKey(id)]: String(failCount),
          [refreshBackoffUntilSecretKey(id)]: String(Date.now() + backoffMs),
        },
        [refreshTransientCountSecretKey(id)],
      );
    } else {
      // Transient: back off exponentially (a provider gone for good decays to a few
      // attempts a day) but leave the *permanent* counter untouched — an outage must
      // never accumulate toward deleting a working sign-in.
      setSecrets({
        [refreshTransientCountSecretKey(id)]: String(transientCount),
        [refreshBackoffUntilSecretKey(id)]: String(Date.now() + backoffMs),
      });
    }
  }
}
