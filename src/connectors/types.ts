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
  | { kind: 'secret'; secretEnv: string } // iteration 1 — paste a token (e.g. GitHub PAT)
  | {
      kind: 'oauth_device';
      secretEnv: string;
      clientId: string;
      scopes: string[];
      deviceCodeUrl: string;
      tokenUrl: string;
    }
  | {
      kind: 'oauth';
      secretEnv: string; // env name holding the (refreshed) access token
      clientId: string;
      clientSecret: string;
      scopes: string[];
      authUrl: string;
      tokenUrl: string;
      redirectPath: string;
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
}

/** Returns the env-var name a spec's secret is stored under, or null for kind 'none'. */
export function secretEnvOf(spec: ConnectorSpec): string | null {
  return spec.auth.kind === 'none' ? null : spec.auth.secretEnv;
}
