/**
 * Connector types.
 *
 * A "connector" is an MCP server the gateway can inject into a Claude Code session's
 * mcp-config.json. The gateway stores only the definition (config.json's
 * gateway.customConnectors), the per-connector secret (mcp-token.env) and the
 * per-agent enablement (AgentConfig.connectors). At spawn, an enabled+connected
 * connector is resolved to an mcpServers entry by resolve.ts — Claude Code then
 * talks to the real MCP server directly.
 */

/**
 * Who holds the connector's credential and is responsible for keeping it valid.
 *
 * This is the only axis along which connectors actually differ. Every route, the
 * refresh sweep and the disconnect semantics all branch on one of these four cases
 * and nothing else, so they are one field rather than the several booleans this
 * started as — `authKind` + `managed` + `oauth` had 8 representable combinations for
 * 4 real states, and which of the 8 you got depended on which route wrote the entry.
 *
 *   'none'     No credential exists. `secretNames` is empty and there is nothing to
 *              connect, disconnect or refresh.
 *   'static'   A human pasted a value through POST /v1/connectors/custom (or
 *              /:id/connect). It is valid until someone replaces it; nothing renews it.
 *   'gateway'  THIS gateway ran the OAuth flow (api/oauth-connectors-router.ts),
 *              holds the refresh_token, and renews the access_token itself
 *              (oauth-refresh-sweep.ts). The only value the sweep acts on.
 *   'external' An external control plane owns the sign-in and pushes fresh tokens in
 *              via POST /v1/connectors/:id/oauth/receive. The gateway stores what it
 *              is handed and never refreshes it — it holds no refresh_token to do so.
 *
 * Deliberately about ownership, not about presentation. An earlier shape reported
 * `source: 'built-in' | 'custom'` — a statement about which badge one particular web
 * panel should draw, which is not the gateway's business to decide and was not read
 * anywhere in this repo. A UI can still derive its badge from this field; the
 * difference is that this field is true independently of any UI.
 *
 * Note what this does NOT affect: secret RESOLUTION is identical for all four. Every
 * connector stores its values under the same `CUSTOM__<id>__<name>` keys and every
 * one is resolved by the same `{placeholder}` substitution — a 'gateway' entry's
 * config must still carry an `{access_token}` placeholder and still list it in
 * `secretNames`, exactly like a pasted static-token one. resolve.ts's
 * resolveEnabledConnectors needs no awareness of this field at all, and should not
 * acquire any.
 */
export type ConnectorCredentialOwner = 'none' | 'static' | 'gateway' | 'external';

export interface ConnectorStatus {
  id: string;
  label: string;
  description?: string;
  /** Mirrors CustomConnectorEntry.credentialOwner — see that type. Tells a caller
   *  which way to offer connecting: a paste-token box ('static'), a "Sign in" link
   *  to this gateway's own oauth/start ('gateway'), or neither ('external' is the
   *  control plane's to drive, 'none' needs nothing). */
  credentialOwner: ConnectorCredentialOwner;
  /** True when the connector's secret is present (or credentialOwner === 'none'). */
  connected: boolean;
  /** CustomConnectorEntry.sourceUrl — where the user says the config came from. */
  repoUrl?: string;
  /**
   * Present only while an oauth connector's background token refresh is failing —
   * see oauth-refresh-sweep.ts, which distinguishes the two kinds below.
   *
   * Transient failures (network, DNS, a 5xx: reasons the authorization server never
   * declared) deliberately never delete the grant, so `connected` stays true off the
   * still-present access_token even once that token has expired and every call
   * through it is failing. Without this the API reports an indefinitely healthy
   * connector that stopped working hours ago.
   */
  refresh?: {
    /** Consecutive transient failures; resets to 0 on the first success. */
    consecutiveFailures: number;
    /**
     * Consecutive refusals by the authorization server itself. At 3 the sweep
     * deletes the stored credentials and `connected` flips to false, so a 2 here
     * is the last warning before this connector disconnects itself.
     */
    permanentFailures: number;
    /** Epoch ms — the sweep skips this connector until then. */
    nextAttemptAt: number;
    /**
     * Set when this connector can never refresh: its access_token has expired and
     * no refresh_token was ever stored. Both counters read 0 here, because nothing
     * ever failed — the sweep has nothing to refresh with, so it skips the connector
     * silently on every tick. Reachable through ordinary configuration: an
     * authorization server that advertises scopes not including `offline_access`
     * issues a token response with no refresh_token at all.
     */
    unrefreshable?: boolean;
  };
}

/**
 * A user-pasted connector: raw mcpServers-entry JSON (from the MCP registry, a
 * docs page, wherever) with `{placeholderName}` tokens standing in for secrets.
 * Stored in config.json's gateway.customConnectors, keyed by a slugified id.
 * There is no build() step — resolve.ts does a generic find-and-replace of
 * `{name}` against the connector's own namespaced secrets (see
 * connectors/custom.ts: customSecretKey, substitutePlaceholders).
 */
export interface CustomConnectorEntry {
  label: string;
  description?: string;
  /** Raw config as pasted, e.g. {"command":"npx","args":["gmail-mcp"]} or
   *  {"type":"streamable-http","url":"...","headers":{"Authorization":"Bearer {api_key}"}}. */
  config: Record<string, unknown>;
  /** Placeholder names found in `config` at add-time, e.g. ['api_key']. */
  secretNames: string[];
  /** Where the user says this config came from — their own reference, unverified. */
  sourceUrl?: string;
  /**
   * Who owns this connector's credential — see ConnectorCredentialOwner.
   *
   * Written once, by whichever route created the entry, and read verbatim
   * everywhere after: POST /v1/connectors/custom decides between 'none', 'static'
   * and 'gateway' from what the admin submitted, and POST /:id/oauth/receive always
   * writes 'external'. Nothing infers it at read time, which is the point — the old
   * shape derived the reported kind from `secretNames.length` on every status call
   * while ALSO storing overrides for the two cases that derivation got wrong.
   *
   * Required rather than optional: an entry whose owner is unknown has no correct
   * default. 'static' would put a paste-token box on an OAuth connector and 'none'
   * would report it permanently connected. There is no legacy on-disk shape to be
   * lenient towards — connectors ship for the first time in this change.
   */
  credentialOwner: ConnectorCredentialOwner;
}
