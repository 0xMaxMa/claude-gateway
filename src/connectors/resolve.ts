/**
 * Connector resolution — the single source of truth shared by the session spawner
 * and the HTTP API.
 *
 * resolveEnabledConnectors(): for the injection point in SessionProcess.writeMcpConfig.
 * listConnectorStatus(): for GET /v1/connectors.
 */

import type { AgentConfig, CustomConnectorEntry } from '../types';
import { type ConnectorStatus } from './types';
import { parseCounter, readTokenEnv } from './token-env';
import { customSecretKey, substitutePlaceholders } from './custom';
import {
  refreshTransientCountSecretKey,
  refreshFailCountSecretKey,
  refreshBackoffUntilSecretKey,
  refreshTokenSecretKey,
  expiresAtSecretKey,
} from './oauth-refresh-sweep';

/**
 * Build the mcpServers entries for every connector that is (a) in customConnectors,
 * (b) enabled for this agent, and (c) connected (every `{placeholder}` secret it
 * declares is present). Returns a map keyed by connector id, ready to merge into
 * mcp-config.json.
 *
 * Enablement defaults to opt-OUT: a globally-connected connector is available to
 * every agent the moment it's connected — an agent only misses it if explicitly
 * disabled (`{enabled: false}`). Connecting a connector at all is the security gate;
 * per-agent is a refinement, not a second required step.
 *
 * `defaultEnabled: false` (gateway.connectorsDefaultEnabled in config.json) flips
 * that to opt-IN. The default suits the common single-operator install, but a
 * gateway hosting agents for several different people is a different situation:
 * there, connecting one connector hands its credential to every agent on the box,
 * including agents whose chat users are not the person who connected it. Opting in
 * per agent is the safer posture for that deployment, so it is available — as a
 * deliberate choice, not a silent change of meaning for existing installs.
 */
export function resolveEnabledConnectors(
  agentConfig: Pick<AgentConfig, 'connectors'>,
  customConnectors: Record<string, CustomConnectorEntry> = {},
  defaultEnabled = true,
): Record<string, unknown> {
  const enabled = agentConfig.connectors ?? {};
  const tokenEnv = readTokenEnv();
  // Null-prototype for the reason the `secrets` map below is one, one level up:
  // `restartSessionsUsingConnector` asks this map what a single id resolves to
  // (`resolved[connectorId]`), and a connector id may legitimately be `constructor`
  // or `valueOf`. On a plain object that lookup answers with an inherited Function
  // for an id that resolves to nothing — a "changed" fingerprint that restarts every
  // session on the box, forever, since it never matches what a spawn recorded.
  const out: Record<string, unknown> = Object.create(null);
  const isEnabled = (id: string): boolean => enabled[id]?.enabled ?? defaultEnabled;

  for (const [id, entry] of Object.entries(customConnectors)) {
    if (!isEnabled(id)) continue; // opted out (or not opted in)

    try {
      // Null-prototype for the same reason token-env.ts's parse() uses one: the
      // names come from a pasted config, and PLACEHOLDER_RE happily matches
      // `{constructor}` or `{toString}`.
      const secrets: Record<string, string> = Object.create(null);
      let allPresent = true;
      for (const name of entry.secretNames) {
        const value = tokenEnv[customSecretKey(id, name)];
        if (!value) {
          allPresent = false;
          break;
        }
        secrets[name] = value;
      }
      if (!allPresent) continue; // enabled but not fully connected — skip

      out[id] = substitutePlaceholders(entry.config, secrets);
    } catch (err) {
      // A malformed pasted config (see CustomConnectorEntry's doc comment:
      // admin-trusted, not code-reviewed) must not take down every other
      // connector's resolution — or worse, the whole session spawn — for
      // every user of this agent. Skip just this one.
      console.error(`resolveEnabledConnectors: connector=${id} resolve failed: ${(err as Error).message}`);
    }
  }

  return out;
}

/**
 * The `refresh` block of ConnectorStatus, or undefined when the connector's
 * background refresh is healthy (or was never failing). Reads the sweep's own
 * bookkeeping out of an already-loaded token env rather than re-reading the file
 * per connector.
 *
 * Both failure streaks are reported, not just the transient one. A connector two
 * refusals into the three-strike permanent count is one tick away from having its
 * credentials deleted — the most actionable state this block can describe, and the
 * one a caller most needs to see before it happens.
 *
 * `unrefreshable` covers the cases with no streak at all. A provider that issues no
 * refresh_token (an AS advertising scopes that don't include `offline_access` — see
 * the scope fallback in mcp-oauth.ts's `resolveScope`) leaves the sweep nothing to
 * refresh with, so it skips the connector on every tick and never records a failure.
 * Without this flag that connector keeps a green checkmark forever over an
 * access_token that expired an hour in, which is the exact state the sweep's module
 * comment says it exists to prevent.
 */
export function refreshStatusOf(
  id: string,
  tokenEnv: Record<string, string>,
): ConnectorStatus['refresh'] {
  // A hand-edited or truncated mcp-token.env can hold anything, and the sweep floors
  // the very same values before deciding whether to delete credentials — `parseCounter`
  // is that floor, shared, so display and decision cannot drift apart.
  const consecutiveFailures = parseCounter(tokenEnv[refreshTransientCountSecretKey(id)]);
  const permanentFailures = parseCounter(tokenEnv[refreshFailCountSecretKey(id)]);
  // Derived, not stored: the sweep never writes a marker for this, and shouldn't —
  // it is a fact about what is already in the file, and computing it here means it
  // cannot drift out of sync with the tokens it describes.
  const expiresAt = parseCounter(tokenEnv[expiresAtSecretKey(id)]);
  // Three states, one flag: there is a token here, nothing can renew it, and it is
  // not currently known-good.
  //
  // `expiresAt === 0` is the third one, and it is not the "not signed in yet" case —
  // that has no access_token at all, and the row already reports `connected: false`
  // without help from here. A 'gateway' connector that HAS an access_token and no
  // recorded expiry is one whose token this gateway never minted: every path that
  // writes one writes an expiry alongside it, defaulting to an hour when the AS
  // omits `expires_in` (see the callback and the sweep). The way to get here is to
  // paste an access_token into an `oauth: true` add — now rejected at that route,
  // but rows already in this state predate the check and are exactly the ones that
  // need saying out loud, since they will simply stop working at a moment nothing
  // recorded.
  const unrefreshable =
    !!tokenEnv[customSecretKey(id, 'access_token')] &&
    !tokenEnv[refreshTokenSecretKey(id)] &&
    (expiresAt === 0 || expiresAt <= Date.now());
  if (!consecutiveFailures && !permanentFailures && !unrefreshable) return undefined;
  return {
    consecutiveFailures,
    permanentFailures,
    nextAttemptAt: parseCounter(tokenEnv[refreshBackoffUntilSecretKey(id)]),
    ...(unrefreshable ? { unrefreshable: true } : {}),
  };
}

/** Connector list + connected state for the API. `connected` reflects secret presence. */
export function listConnectorStatus(
  customConnectors: Record<string, CustomConnectorEntry> = {},
): ConnectorStatus[] {
  const tokenEnv = readTokenEnv();

  return Object.entries(customConnectors).map(([id, entry]) => {
    try {
      const connected = entry.secretNames.every(
        (name: string) => !!tokenEnv[customSecretKey(id, name)],
      );
      // Omitted rather than set to undefined when refresh is healthy: the single-status
      // route omits it too, and a caller doing `'refresh' in status` should get the same
      // answer from both.
      //
      // 'gateway' only. An 'external' entry is refreshed by the control plane that
      // pushed it — this gateway holds no refresh_token for it, so the sweep skips it
      // and every counter here would read a constant 0.
      const refresh = entry.credentialOwner === 'gateway' ? refreshStatusOf(id, tokenEnv) : undefined;
      return {
        id,
        label: entry.label,
        description: entry.description,
        credentialOwner: entry.credentialOwner,
        connected,
        repoUrl: entry.sourceUrl,
        ...(refresh ? { refresh } : {}),
      } as ConnectorStatus;
    } catch (err) {
      // Same per-entry isolation resolveEnabledConnectors uses above, and for a
      // sharper reason: `entry.secretNames` is typed but never validated at read
      // time, so one hand-edited (or older-build) config.json entry missing it
      // throws here — inside an `async` Express 4 handler, which does not catch
      // rejections. The request then never gets a response at all and the whole
      // connector panel hangs, rather than one row degrading.
      console.error(`listConnectorStatus: connector=${id} status failed: ${(err as Error).message}`);
      return {
        id,
        label: typeof entry?.label === 'string' ? entry.label : id,
        description: 'This connector’s configuration could not be read.',
        // Not the entry's own value, even if it has a readable one: this row
        // describes a connector nothing can be done with, and every other owner
        // would invite a caller to offer a connect action that cannot work.
        credentialOwner: 'none',
        connected: false,
      } as ConnectorStatus;
    }
  });
}
