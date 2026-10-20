/**
 * Loopback MCP proxy for secret-bearing HTTP connectors (#635).
 *
 * An HTTP connector's resolved mcpServers entry carries its credential in a header
 * (`Authorization: Bearer <api_key>`). Writing that entry into an mcp-config file
 * hands the credential to every process the agent runs, since they all run as the
 * file's owner. Instead, the file gets an entry pointing at this gateway, holding a
 * per-spawn grant token. The gateway resolves the real entry in memory on every
 * request and forwards to the configured upstream, so the secret never touches disk
 * and a revoked grant or a disconnected/disabled connector fails closed mid-session.
 *
 * stdio and SSE connectors whose secrets sit in env/args cannot be covered by a
 * header proxy; they are still written resolved, and `exposesSecretToAgent` lets the
 * connectors API say so instead of leaving it silent (see custom.ts).
 */

import { randomBytes } from 'crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import { Router, type Request, type Response } from 'express';
import type { AgentConfig, GatewayConfig } from '../types';
import type { CustomConnectorEntry } from './types';
import { resolveEnabledConnectors } from './resolve';
import { isProxiedConnector, isStreamableHttpType } from './custom';

export const CONNECTOR_PROXY_PATH = '/internal/mcp/connectors';

interface Grant {
  connectorIds: ReadonlySet<string>;
  resolve: (id: string) => unknown;
}

const grants = new Map<string, Grant>();

/** Client headers the MCP streamable-HTTP transport needs; everything else, including
 * the grant's own Authorization, is dropped so a caller cannot add or override one. */
const FORWARDED_REQUEST_HEADERS = ['accept', 'content-type', 'content-length', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'content-encoding', 'mcp-session-id', 'cache-control'];

function proxyBaseUrl(): string {
  return (process.env.GATEWAY_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? '10850'}`).replace(/\/+$/, '');
}

/**
 * Replace every secret-bearing HTTP connector in `resolved` with a proxy entry and
 * mint one grant covering them. `resolved` itself stays the in-memory source of
 * truth for restart fingerprints; only the returned `servers` may be written to disk.
 * The caller owns the grant and must revoke it when the spawn that uses it ends.
 */
export function agentFacingConnectors(
  agent: Pick<AgentConfig, 'connectors' | 'isolateMemory'>,
  gateway: GatewayConfig,
  resolved: Record<string, unknown>,
): { servers: Record<string, unknown>; grant?: string } {
  const entries = gateway.gateway?.customConnectors ?? {};
  const entryOf = (id: string): CustomConnectorEntry | undefined =>
    Object.prototype.hasOwnProperty.call(entries, id) ? entries[id] : undefined;
  const servers: Record<string, unknown> = { ...resolved };
  const proxied = Object.keys(resolved).filter(id => isProxiedConnector(entryOf(id)));
  if (!proxied.length) return { servers };

  const grant = randomBytes(32).toString('base64url');
  grants.set(grant, {
    connectorIds: new Set(proxied),
    // Re-resolved per request against the live config objects, so disconnecting a
    // connector (its secret deleted) or disabling it for the agent takes effect on
    // the next call rather than at the next restart.
    resolve: id => {
      if (agent.isolateMemory) return undefined;
      const current = gateway.gateway?.customConnectors ?? {};
      if (!Object.prototype.hasOwnProperty.call(current, id)) return undefined;
      return resolveEnabledConnectors(agent, { [id]: current[id] }, gateway.gateway?.connectorsDefaultEnabled ?? true)[id];
    },
  });
  const base = proxyBaseUrl();
  for (const id of proxied) {
    // The unresolved config holds `{placeholder}`s, never secrets, so its remaining
    // fields (type, enabled_tools, disabled_tools, ...) are kept as configured.
    const { url: _url, headers: _headers, ...rest } = entryOf(id)!.config;
    servers[id] = {
      ...rest,
      url: `${base}${CONNECTOR_PROXY_PATH}/${encodeURIComponent(id)}`,
      headers: { Authorization: `Bearer ${grant}` },
    };
  }
  return { servers, grant };
}

export function revokeConnectorGrant(grant: string | undefined): void {
  if (grant) grants.delete(grant);
}

/** Loopback, or a same-host client that reached a non-loopback bind address. */
function isSameHost(req: Request): boolean {
  const remote = req.socket.remoteAddress ?? '';
  return remote === req.socket.localAddress || /^(127\.|::1$|::ffff:127\.)/.test(remote);
}

function upstreamOf(server: unknown): { url: URL; headers: Record<string, string> } | undefined {
  if (!server || typeof server !== 'object') return undefined;
  const { type, url, headers } = server as { type?: unknown; url?: unknown; headers?: unknown };
  if (!isStreamableHttpType(type) || typeof url !== 'string') return undefined;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  const out: Record<string, string> = {};
  if (headers !== undefined) {
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return undefined;
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value !== 'string') return undefined;
      out[name.toLowerCase()] = value;
    }
  }
  return { url: parsed, headers: out };
}

/** Mounted on the root app BEFORE the JSON body parser: the request body is streamed
 * to the upstream unread, so no size limit applies that a direct connection lacked. */
export function createConnectorProxyRouter(): Router {
  const router = Router();
  router.all(`${CONNECTOR_PROXY_PATH}/:id`, (req: Request, res: Response) => {
    if (!isSameHost(req)) { res.status(403).json({ error: 'Forbidden' }); return; }
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    const grant = match ? grants.get(match[1]) : undefined;
    if (!grant) { res.status(401).json({ error: 'Unauthorized' }); return; }
    const id = req.params['id'] ?? '';
    if (!grant.connectorIds.has(id)) { res.status(403).json({ error: 'Forbidden' }); return; }
    if (!['GET', 'POST', 'DELETE'].includes(req.method)) { res.status(405).json({ error: 'Method not allowed' }); return; }
    let upstream: ReturnType<typeof upstreamOf>;
    try {
      upstream = upstreamOf(grant.resolve(id));
    } catch (err) {
      console.error(`connector-proxy: connector=${id} resolve failed: ${(err as Error).message}`);
    }
    if (!upstream) { res.status(403).json({ error: 'Connector is not available' }); return; }

    const headers: Record<string, string> = {};
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    Object.assign(headers, upstream.headers);

    let outbound: http.ClientRequest;
    try {
      // node:http rather than fetch: undici's default 300s headers/body timeouts
      // would cut long tool calls and idle SSE streams the agent's client allows.
      outbound = (upstream.url.protocol === 'https:' ? https : http).request(upstream.url, { method: req.method, headers }, incoming => {
        const status = incoming.statusCode ?? 502;
        // Same stance as manageResource's `redirect: 'error'`: the upstream is the
        // configured URL, and the credential is never replayed somewhere else.
        if (status >= 300 && status < 400) {
          incoming.resume();
          res.status(502).json({ error: 'Upstream redirect refused' });
          return;
        }
        res.status(status);
        for (const name of FORWARDED_RESPONSE_HEADERS) {
          const value = incoming.headers[name];
          if (value !== undefined) res.setHeader(name, value);
        }
        res.flushHeaders();
        incoming.pipe(res);
      });
    } catch (err) {
      // An invalid header value in the pasted config throws synchronously.
      console.error(`connector-proxy: connector=${id} request rejected: ${(err as Error).message}`);
      res.status(502).json({ error: 'Upstream request failed' });
      return;
    }
    outbound.on('error', err => {
      console.error(`connector-proxy: connector=${id} upstream failed: ${err.message}`);
      if (!res.headersSent) res.status(502).json({ error: 'Upstream request failed' });
      else res.destroy();
    });
    // The agent's client went away (cancelled call, closed SSE stream): stop upstream too.
    res.on('close', () => outbound.destroy());
    req.pipe(outbound);
  });
  return router;
}
