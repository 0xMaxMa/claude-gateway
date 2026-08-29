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
    }
  | {
      // Managed externally by services/api (getpod-ai), NOT by this gateway —
      // the gateway never sees a client_secret or a refresh_token, only ever
      // receives a short-lived access_token via POST
      // /v1/connectors/:id/oauth/receive (connectors-router.ts). Reason: this
      // gateway runs inside the user's own VM (SSH + agent shell access), so
      // a client_secret shared across every user could never live here
      // safely. The web panel shows a "Connect" link to services/api's own
      // OAuth start endpoint instead of the paste-a-token modal `secretEnv`
      // kinds use.
      kind: 'oauth';
      secretEnv: string;
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
}
