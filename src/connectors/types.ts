/**
 * Connector catalog types.
 *
 * A "connector" is a managed MCP server the gateway can inject into a Claude Code
 * session's mcp-config.json. The gateway only stores the catalog (here, in code),
 * the per-connector secret (in mcp-token.env), and the per-agent enablement
 * (AgentConfig.connectors). At spawn, an enabled+connected connector is resolved to
 * an mcpServers entry via spec.build(secret) — Claude Code then talks to the real
 * MCP server directly.
 */

export type ConnectorAuthKind = 'none' | 'secret' | 'oauth_device' | 'oauth';
export type ConnectorTransport = 'http' | 'stdio';

// Note: there is deliberately no 'oauth' variant here. A *built-in*
// ConnectorSpec can never be oauth-kind — that concept now lives only on
// CustomConnectorEntry.authKind below, since every oauth-managed connector
// (github/gmail/google-drive/google-calendar) is pushed in as a managed
// custom connector by an external control plane, not declared in catalog.ts. See
// CustomConnectorEntry's doc comment for why.
export type ConnectorAuth =
  | { kind: 'none' }
  | { kind: 'secret'; secretEnv: string } // paste a token (e.g. GitHub PAT)
  | {
      kind: 'oauth_device';
      secretEnv: string;
      clientId: string;
      scopes: string[];
      deviceCodeUrl: string;
      tokenUrl: string;
    };

/**
 * UI-only help for obtaining a connector's secret (e.g. a deep link to GitHub's
 * PAT-creation page with scopes pre-filled). Pure presentation metadata — never
 * reaches spec.build() or the written mcp-config.json.
 */
export interface ConnectorSetup {
  /** Deep link that generates/obtains the token (opened in a new tab). */
  tokenUrl: string;
  /** Button label, e.g. 'Create a GitHub token'. */
  label?: string;
  /** One-line instruction shown under the paste box. */
  hint?: string;
}

export interface ConnectorSpec {
  /** Stable id, also the mcpServers entry name (e.g. 'github'). */
  id: string;
  /** Human label for the UI. */
  label: string;
  description?: string;
  transport: ConnectorTransport;
  auth: ConnectorAuth;
  /** Optional guided token-generation help for the web panel. */
  setup?: ConnectorSetup;
  /**
   * Link to the underlying MCP server's repo/docs/vendor page — shown as a
   * small external link in the web panel so a user can see what they're
   * actually running before connecting (most of today's catalog is a
   * community package, not an Anthropic/vendor-official one).
   */
  repoUrl?: string;
  /**
   * Build the mcpServers entry for this connector. `secret` is the resolved token
   * (null for auth.kind === 'none' or when not yet connected).
   */
  build(secret: string | null): Record<string, unknown>;
}

export interface ConnectorStatus {
  id: string;
  label: string;
  description?: string;
  authKind: ConnectorAuthKind;
  /** True when the connector's secret is present (or auth.kind === 'none'). */
  connected: boolean;
  /** Optional guided token-generation help for the web panel. */
  setup?: ConnectorSetup;
  /**
   * 'built-in' = code-reviewed CONNECTOR_CATALOG entry (the security boundary —
   * only vetted servers). 'custom' = user-pasted raw mcpServers JSON, admin-trusted
   * but NOT code-reviewed — see connectors/custom.ts.
   */
  source: 'built-in' | 'custom';
  /** repoUrl (built-in) or sourceUrl (custom) — see their doc comments. */
  repoUrl?: string;
  /** Mirrors CustomConnectorEntry.oauth — tells the web panel to render a
   *  "Connect" link pointed at THIS gateway's oauth/start endpoint instead of
   *  a paste-token modal. Always absent for built-in entries. */
  oauth?: boolean;
}

/** Returns the env-var name a spec's secret is stored under, or null for kind 'none'. */
export function secretEnvOf(spec: ConnectorSpec): string | null {
  return spec.auth.kind === 'none' ? null : spec.auth.secretEnv;
}

/**
 * A user-pasted connector: raw mcpServers-entry JSON (from the MCP registry, a
 * docs page, wherever) with `{placeholderName}` tokens standing in for secrets.
 * Stored in config.json's gateway.customConnectors, keyed by a slugified id.
 * Unlike ConnectorSpec, there's no build() — resolve.ts does a generic
 * find-and-replace of `{name}` against the connector's own namespaced secrets
 * (see connectors/custom.ts: customSecretKey, substitutePlaceholders).
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
   * Set ONLY by an external control plane's push (POST /oauth/receive) for a
   * managed OAuth connector (github/gmail/google-drive/google-calendar, say)
   * — never by a genuine user-pasted add (POST /v1/connectors/custom leaves
   * this unset). listConnectorStatus reports this verbatim instead of
   * inferring from secretNames, since a managed entry IS oauth-kind even
   * though it lives in the same customConnectors storage as a user-pasted one.
   */
  authKind?: 'oauth';
  /**
   * Set ONLY by that same push, same as authKind above — tells
   * listConnectorStatus to report `source: 'built-in'` instead of 'custom' so
   * the web panel doesn't show the "Custom" badge on something the deployer's
   * own control plane implemented and pushed in, not something the user
   * pasted themselves.
   */
  managed?: boolean;
  /**
   * Set when the admin who added this connector marked it as "this MCP
   * server uses OAuth sign-in" (see api/oauth-connectors-router.ts). Purely a
   * discovery/UX hint — it does NOT change how the secret is resolved
   * (`config` must still carry an `{access_token}` placeholder, and
   * `secretNames` must still include `'access_token'`, exactly like a
   * user-pasted static-token connector; connectors/resolve.ts needs no
   * awareness of this field at all). It only tells the web panel to show a
   * "Connect" button that hits `oauth/start` on THIS gateway (not an
   * external control plane), and tells `oauth/start` which `config.url` to
   * run discovery against.
   */
  oauth?: boolean;
}
