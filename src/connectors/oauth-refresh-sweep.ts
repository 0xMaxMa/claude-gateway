/**
 * Periodic refresh for OAuth-flavored custom connectors (CustomConnectorEntry.oauth
 * === true) — the gateway-side counterpart to whatever refresh loop an external
 * control plane runs for its own managed connectors. Runs on the same 60s
 * interval as cliPairingStore.prune() (see gateway-router.ts) via
 * refreshExpiringOAuthConnectors().
 *
 * Storage note: refresh_token, the client_id used to obtain it, the access_token's
 * expiry timestamp, and this sweep's own failure bookkeeping are stored via the
 * existing customSecretKey()-namespaced mcp-token.env mechanism under synthetic,
 * double-underscore-prefixed names (`__refresh_token`, `__client_id`,
 * `__token_expires_at`, `__refresh_fail_count`, `__refresh_backoff_until`,
 * `__token_generation`) — never a real {placeholder} from the pasted config, so
 * extractPlaceholders() at add-time never picks them up as user-facing secrets.
 * Reusing this storage (rather than a new file) keeps exactly one place that holds
 * connector secrets.
 */

import type { AgentRunner } from '../agent/runner';
import type { CustomConnectorsStore } from './custom-connectors-store';
import { customSecretKey } from './custom';
import { getSecret, setSecret, deleteSecret } from './token-env';
import { discoverOAuthMetadata, refreshAccessToken } from './mcp-oauth';

const REFRESH_SKEW_MS = 5 * 60 * 1000;
// After a failed refresh, wait this long before trying that connector again —
// without this a permanently-broken refresh_token (network blip is fine and
// self-heals next tick, but a revoked/expired one never will) gets hammered
// every single 60s tick forever.
const REFRESH_BACKOFF_MS = 5 * 60 * 1000;
// Consecutive failures before giving up on a connector entirely: clear its
// tokens so `hasSecret`-based status flips to "not connected" (a real signal
// the user can act on) instead of an indefinitely-retrying green checkmark
// backed by a token that will never refresh again.
const MAX_CONSECUTIVE_FAILURES = 3;

export function refreshTokenSecretKey(id: string): string {
  return customSecretKey(id, '__refresh_token');
}
export function clientIdSecretKey(id: string): string {
  return customSecretKey(id, '__client_id');
}
export function expiresAtSecretKey(id: string): string {
  return customSecretKey(id, '__token_expires_at');
}
export function refreshFailCountSecretKey(id: string): string {
  return customSecretKey(id, '__refresh_fail_count');
}
export function refreshBackoffUntilSecretKey(id: string): string {
  return customSecretKey(id, '__refresh_backoff_until');
}
/** Bumped on every write of a connector's access_token — by the OAuth callback
 *  on a fresh sign-in AND by this sweep on a successful refresh. Read back
 *  before this sweep commits its own refreshed token so a fresh manual
 *  reconnect that lands mid-refresh always wins instead of being silently
 *  clobbered by a slower, now-stale refresh attempt (see tokenGenerationKey's
 *  use below). */
export function tokenGenerationSecretKey(id: string): string {
  return customSecretKey(id, '__token_generation');
}

/**
 * Scan every oauth:true custom connector; refresh any whose access_token is
 * within REFRESH_SKEW_MS of its recorded expiry. Best-effort per connector —
 * one failure (network blip, revoked refresh_token) is logged and skipped,
 * never throws out of the sweep so one broken connector can't stop the rest
 * from refreshing. `agents` (optional, all live AgentRunners) lets a
 * successful refresh restart sessions already using the connector, the same
 * way POST /oauth/receive does for managed connectors — a live session's MCP
 * subprocess has the OLD token baked into its env and can't be hot-patched.
 */
export async function refreshExpiringOAuthConnectors(
  store: CustomConnectorsStore,
  agents?: Map<string, AgentRunner>,
): Promise<void> {
  const connectors = await store.read();
  for (const [id, entry] of Object.entries(connectors)) {
    if (!entry.oauth) continue;

    const backoffUntilRaw = getSecret(refreshBackoffUntilSecretKey(id));
    if (backoffUntilRaw && Number(backoffUntilRaw) > Date.now()) continue; // recent failure — still backing off

    const expiresAtRaw = getSecret(expiresAtSecretKey(id));
    const expiresAt = expiresAtRaw ? Number(expiresAtRaw) : null;
    if (expiresAt && expiresAt - Date.now() >= REFRESH_SKEW_MS) continue; // not due yet

    const refreshToken = getSecret(refreshTokenSecretKey(id));
    const clientId = getSecret(clientIdSecretKey(id));
    const mcpUrl = typeof entry.config.url === 'string' ? entry.config.url : null;
    if (!refreshToken || !clientId || !mcpUrl) continue; // nothing to refresh with (e.g. disconnected)

    // Captured before the two network round-trips below so a concurrent
    // manual reconnect (a fresh /oauth/mcp/callback exchange for this same
    // connector, racing this refresh) can be detected before this sweep
    // commits a write derived from what may now be a stale refresh_token.
    const generationBefore = getSecret(tokenGenerationSecretKey(id));

    try {
      const metadata = await discoverOAuthMetadata(mcpUrl);
      const token = await refreshAccessToken({ metadata, clientId, refreshToken });

      if (getSecret(tokenGenerationSecretKey(id)) !== generationBefore) {
        // Someone else (a manual reconnect) wrote a newer token while this
        // refresh was in flight — that write is strictly fresher than
        // whatever this call would produce, so abandon ours rather than
        // clobber it. Not a failure: don't touch the backoff/fail-count.
        continue;
      }

      setSecret(customSecretKey(id, 'access_token'), token.access_token);
      if (token.refresh_token) setSecret(refreshTokenSecretKey(id), token.refresh_token);
      setSecret(expiresAtSecretKey(id), String(Date.now() + (token.expires_in ?? 3600) * 1000));
      setSecret(tokenGenerationSecretKey(id), String(Date.now()));
      deleteSecret(refreshFailCountSecretKey(id));
      deleteSecret(refreshBackoffUntilSecretKey(id));

      if (agents) {
        await Promise.all(
          [...agents.values()].map((runner) => runner.restartSessionsUsingConnector(id)),
        );
      }
    } catch (err) {
      console.error(`oauth-refresh-sweep: connector=${id} refresh failed: ${(err as Error).message}`);
      const failCount = Number(getSecret(refreshFailCountSecretKey(id)) ?? '0') + 1;
      if (failCount >= MAX_CONSECUTIVE_FAILURES) {
        // Give up — a refresh_token that fails this many times in a row is
        // not coming back on its own (revoked, or the provider rotated it
        // out from under us). Clear everything so status correctly reports
        // "not connected" instead of a stale green checkmark, and so this
        // loop stops calling a dead token endpoint on every future tick.
        deleteSecret(customSecretKey(id, 'access_token'));
        deleteSecret(refreshTokenSecretKey(id));
        deleteSecret(clientIdSecretKey(id));
        deleteSecret(expiresAtSecretKey(id));
        deleteSecret(refreshFailCountSecretKey(id));
        deleteSecret(refreshBackoffUntilSecretKey(id));
      } else {
        setSecret(refreshFailCountSecretKey(id), String(failCount));
        setSecret(refreshBackoffUntilSecretKey(id), String(Date.now() + REFRESH_BACKOFF_MS));
      }
    }
  }
}
