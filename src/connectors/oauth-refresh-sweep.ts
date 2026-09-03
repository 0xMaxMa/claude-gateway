/**
 * Periodic refresh for OAuth-flavored custom connectors (CustomConnectorEntry.oauth
 * === true) — the gateway-side analog of services/api's
 * google_connector_subscription.go (StartGoogleConnectorRefreshSweep /
 * refreshExpiringGoogleConnectors). Runs on the same 60s interval as
 * cliPairingStore.prune() (see gateway-router.ts) via refreshExpiringOAuthConnectors().
 *
 * Storage note: refresh_token, the client_id used to obtain it, and the
 * access_token's expiry timestamp are stored via the existing
 * customSecretKey()-namespaced mcp-token.env mechanism under synthetic,
 * double-underscore-prefixed names (`__refresh_token`, `__client_id`,
 * `__token_expires_at`) — never a real {placeholder} from the pasted config,
 * so extractPlaceholders() at add-time never picks them up as user-facing
 * secrets. Reusing this storage (rather than a new file) keeps exactly one
 * place that holds connector secrets.
 */

import type { CustomConnectorsStore } from './custom-connectors-store';
import { customSecretKey } from './custom';
import { getSecret, setSecret } from './token-env';
import { discoverOAuthMetadata, refreshAccessToken } from './mcp-oauth';

const REFRESH_SKEW_MS = 5 * 60 * 1000;

export function refreshTokenSecretKey(id: string): string {
  return customSecretKey(id, '__refresh_token');
}
export function clientIdSecretKey(id: string): string {
  return customSecretKey(id, '__client_id');
}
export function expiresAtSecretKey(id: string): string {
  return customSecretKey(id, '__token_expires_at');
}

/**
 * Scan every oauth:true custom connector; refresh any whose access_token is
 * within REFRESH_SKEW_MS of its recorded expiry. Best-effort per connector —
 * one failure (network blip, revoked refresh_token) is logged and skipped,
 * never throws out of the sweep so one broken connector can't stop the rest
 * from refreshing.
 */
export async function refreshExpiringOAuthConnectors(store: CustomConnectorsStore): Promise<void> {
  const connectors = await store.read();
  for (const [id, entry] of Object.entries(connectors)) {
    if (!entry.oauth) continue;

    const expiresAtRaw = getSecret(expiresAtSecretKey(id));
    const expiresAt = expiresAtRaw ? Number(expiresAtRaw) : null;
    if (expiresAt && expiresAt - Date.now() >= REFRESH_SKEW_MS) continue; // not due yet

    const refreshToken = getSecret(refreshTokenSecretKey(id));
    const clientId = getSecret(clientIdSecretKey(id));
    const mcpUrl = typeof entry.config.url === 'string' ? entry.config.url : null;
    if (!refreshToken || !clientId || !mcpUrl) continue; // nothing to refresh with

    try {
      const metadata = await discoverOAuthMetadata(mcpUrl);
      const token = await refreshAccessToken({ metadata, clientId, refreshToken });
      setSecret(customSecretKey(id, 'access_token'), token.access_token);
      if (token.refresh_token) setSecret(refreshTokenSecretKey(id), token.refresh_token);
      setSecret(
        expiresAtSecretKey(id),
        String(Date.now() + (token.expires_in ?? 3600) * 1000),
      );
    } catch (err) {
      console.error(`oauth-refresh-sweep: connector=${id} refresh failed: ${(err as Error).message}`);
    }
  }
}
