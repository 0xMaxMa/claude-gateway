/**
 * Connector secrets stay in the gateway (#635).
 *
 * A connector's resolved mcpServers entry carries its credential: a header for HTTP,
 * env/args for stdio. Writing that entry into an mcp-config file hands the credential
 * to every process the agent runs, since they all run as the file's owner. Instead,
 * the file gets an entry that reaches the connector through this gateway with a
 * per-spawn grant (see connectorSecretRoute in custom.ts):
 *
 *   proxy   HTTP connectors: Claude Code's HTTP transport talks to the loopback route
 *           below, which resolves the real entry per request and forwards upstream.
 *   launch  stdio/SSE connectors: a stdio launcher (mcp/connector-launcher.mjs) upgrades
 *           a gateway connection to a raw stream, and the gateway spawns
 *           mcp/connector-bridge.ts with the resolved entry on its stdin.
 *
 * Legacy app-agent containers cannot reach the host loopback address. They launch
 * every connector through a unix socket the gateway binds in the bind-mounted
 * workspace, and the bridge runs inside the same container with `docker exec`, so
 * stdio servers and upstream URLs see the container's filesystem and network as before.
 *
 * A revoked grant, or a disconnected/disabled/paused/out-of-scope connector, fails
 * closed on the next request or MCP operation.
 */

import { randomBytes } from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'node:http';
import * as https from 'node:https';
import { userInfo } from 'os';
import * as path from 'path';
import { pipeline, type Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import type { AgentConfig, GatewayConfig } from '../types';
import type { CustomConnectorEntry } from './types';
import { resolveEnabledConnectors } from './resolve';
import { agentFacingFields, connectorSecretRoute, isStreamableHttpType } from './custom';
import { sanitizeJevChildEnv } from '../jev/child-env';
import { clearRuntimeExposure, recordRuntimeExposure } from './exposure';
import { MAX_REDIRECTS, sameOriginRedirect } from './redirect';
import { connectorSidecars } from './sidecar';

export const CONNECTOR_PROXY_PATH = '/internal/mcp/connectors';

/** Where a legacy app-agent's launched connectors run: its container, reached
 * through a socket in `hostDir`, which the container mounts at `containerDir`. */
export interface ContainerLaunch {
  container: string;
  hostDir: string;
  containerDir: string;
  /** connector-bridge.ts bundled for Node. Sent over the bridge's stdin, never put in
   * the workspace, where the agent could replace code that receives the secret. */
  bridgeCode: string;
}

/** Runs the bridge module that arrives as the first stdin line (a JSON string), then
 * leaves the rest of stdin to it. */
const CONTAINER_BRIDGE_LOADER = "let b=Buffer.alloc(0);const on=c=>{b=Buffer.concat([b,c]);const i=b.indexOf(10);if(i<0)return;process.stdin.off('data',on);process.stdin.pause();const code=JSON.parse(b.subarray(0,i).toString('utf8'));process.stdin.unshift(b.subarray(i+1));const M=require('module');const m=new M('/gateway-connector-bridge.cjs');m.filename='/gateway-connector-bridge.cjs';m.paths=[];m._compile(code,m.filename);};process.stdin.on('data',on);";

interface Grant {
  agentId: string;
  routes: ReadonlyMap<string, 'proxy' | 'launch'>;
  resolve: (id: string) => unknown;
  container?: ContainerLaunch;
  /** Discovery strips Jev credential names from connector env; sessions never did. */
  cleanEnv: (env: Record<string, string>) => Record<string, string>;
  bridges: Set<ChildProcess>;
  revoked?: true;
  socket?: { server: http.Server; file: string };
}

export const LAUNCH_PROTOCOL = 'gateway-connector-stdio';
const LAUNCHER = path.resolve(__dirname, '../../mcp/connector-launcher.mjs');
const BRIDGE = path.resolve(__dirname, '../../mcp/connector-bridge.ts');
/** sun_path is 108 bytes on Linux, terminator included. */
const MAX_SOCKET_PATH = 107;
/** Request bodies kept for a same-origin 307/308 replay; MCP messages are far smaller. */
const MAX_REPLAY_BYTES = 4 * 1024 * 1024;

const grants = new Map<string, Grant>();

/** Only non-secret runtime basics from the launching agent reach a connector.
 * Connector-specific credentials belong in that connector's explicit `env`. */
const CONNECTOR_INHERITED_ENV = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
]);

/** Client headers the MCP streamable-HTTP transport needs; everything else, including
 * the grant's own Authorization, is dropped so a caller cannot add or override one. */
const FORWARDED_REQUEST_HEADERS = ['accept', 'content-type', 'content-length', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'content-encoding', 'mcp-session-id', 'cache-control'];

let listenOrigin: string | undefined;

/** Records where the gateway's HTTP server listens, so a proxy entry never points at
 * an address nothing serves (a specific GATEWAY_BIND, `::1`) or at a GATEWAY_API_URL
 * meant for another network. Set from the bind config before any agent starts, then
 * from the bound address once listening. */
export function setConnectorProxyOrigin(address: AddressInfo | { address: string; port: number } | string | null | undefined): void {
  if (!address || typeof address === 'string') { listenOrigin = undefined; return; }
  const bound = address.address.trim();
  const host = !bound || bound === '0.0.0.0' || bound === '::' ? '127.0.0.1'
    : bound.includes(':') && !bound.startsWith('[') ? `[${bound}]` : bound;
  listenOrigin = `http://${host}:${address.port}`;
}

function proxyBaseUrl(): string {
  return listenOrigin ?? (process.env.GATEWAY_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? '10850'}`).replace(/\/+$/, '');
}

/**
 * Replace every secret-bearing connector in `resolved` with an entry that reaches it
 * through the gateway, and mint one grant covering them. `resolved` itself stays the
 * in-memory source of truth for restart fingerprints; only the returned `servers` may
 * be written to disk. The caller owns the grant and must revoke it when the spawn
 * that uses it ends.
 *
 * `container` is set for a legacy app-agent session whose container can run the
 * launcher (see prepareContainerLaunch). `containerUnavailable` marks one whose
 * container cannot: it keeps the resolved entries, since nothing else in the container
 * can reach the gateway. Either fallback is recorded for the status API, which then
 * reports this agent's secrets as agent-readable (connectors/exposure.ts).
 *
 * `proxied` names the connectors written as proxy entries. Their file entry holds no
 * resolved value, so only `proxiedShape` changing needs a respawn (see
 * SessionProcess.connectorConfigChanged).
 */
export function agentFacingConnectors(
  agent: Pick<AgentConfig, 'id' | 'connectors' | 'isolateMemory'>,
  gateway: GatewayConfig,
  resolved: Record<string, unknown>,
  options: { container?: ContainerLaunch; containerUnavailable?: boolean; sanitizeEnv?: boolean } = {},
): { servers: Record<string, unknown>; grant?: string; proxied: ReadonlySet<string> } {
  const entries = gateway.gateway?.customConnectors ?? {};
  const entryOf = (id: string): CustomConnectorEntry | undefined =>
    Object.prototype.hasOwnProperty.call(entries, id) ? entries[id] : undefined;
  const servers: Record<string, unknown> = { ...resolved };
  const routes = new Map<string, 'proxy' | 'launch'>();
  for (const id of Object.keys(resolved)) {
    const route = connectorSecretRoute(entryOf(id));
    // A container cannot reach the loopback proxy, so its HTTP connectors launch too.
    if (route === 'proxy') routes.set(id, options.container ? 'launch' : 'proxy');
    else if (route === 'launch') routes.set(id, 'launch');
  }
  const proxied = new Set<string>();
  const fallBack = (): { servers: Record<string, unknown>; grant: string; proxied: ReadonlySet<string> } => {
    // A direct-entry fallback is still owned by this live session. Keep its
    // exposure until that session ends; a later discovery or spawn is independent.
    const exposureGrant = randomBytes(32).toString('base64url');
    grants.set(exposureGrant, {
      agentId: agent.id,
      routes: new Map(),
      resolve: () => undefined,
      cleanEnv: env => env,
      bridges: new Set(),
    });
    recordRuntimeExposure(exposureGrant, agent.id, routes.keys());
    return { servers, grant: exposureGrant, proxied };
  };
  if (!routes.size) return { servers, proxied };
  if (options.containerUnavailable && !options.container) {
    console.warn(`connector-proxy: agent=${agent.id} container cannot launch connectors; ${[...routes.keys()].join(', ')} keep their resolved entries`);
    return fallBack();
  }

  const grant = randomBytes(32).toString('base64url');
  const record: Grant = {
    agentId: agent.id,
    routes,
    // Re-resolved per request, so a disconnected connector (its secret deleted) or a
    // removed entry fails on the next call. The agent config object is shared with
    // its runner, so current per-agent scope changes are checked in-flight too.
    resolve: id => {
      if (agent.isolateMemory) return undefined;
      const current = gateway.gateway?.customConnectors ?? {};
      if (!Object.prototype.hasOwnProperty.call(current, id)) return undefined;
      return resolveEnabledConnectors(agent, { [id]: current[id] }, gateway.gateway?.connectorsDefaultEnabled ?? true)[id];
    },
    container: options.container,
    cleanEnv: env => options.sanitizeEnv
      ? sanitizeJevChildEnv(Object.fromEntries(Object.entries(env).filter(([name]) => CONNECTOR_INHERITED_ENV.has(name.toUpperCase()))), gateway.gateway?.jev)
      : env,
    bridges: new Set(),
  };
  let socketName: string | undefined;
  if (options.container) {
    socketName = `${randomBytes(6).toString('hex')}.sock`;
    const file = path.join(options.container.hostDir, socketName);
    if (Buffer.byteLength(file) > MAX_SOCKET_PATH) {
      console.warn(`connector-proxy: agent=${agent.id} socket path ${file} is too long; ${[...routes.keys()].join(', ')} keep their resolved entries`);
      return fallBack();
    }
    record.socket = { server: listenOnSocket(file), file };
  }
  grants.set(grant, record);

  const base = proxyBaseUrl();
  for (const [id, route] of routes) {
    const config = entryOf(id)!.config;
    const kept = agentFacingFields(config);
    if (route === 'proxy') {
      servers[id] = { ...proxiedShape(entryOf(id)!), url: `${base}${CONNECTOR_PROXY_PATH}/${encodeURIComponent(id)}`, headers: { Authorization: `Bearer ${grant}` } };
      proxied.add(id);
      continue;
    }
    const launchPath = `${CONNECTOR_PROXY_PATH}/${encodeURIComponent(id)}/stdio`;
    servers[id] = options.container
      ? { ...kept, command: 'node', args: [`${options.container.containerDir}/connector-launcher.mjs`], env: { GATEWAY_CONNECTOR_SOCKET: `${options.container.containerDir}/${socketName}`, GATEWAY_CONNECTOR_PATH: launchPath, GATEWAY_CONNECTOR_GRANT: grant } }
      : { ...kept, command: process.execPath, args: [LAUNCHER], env: { GATEWAY_CONNECTOR_URL: `${base}${launchPath}`, GATEWAY_CONNECTOR_GRANT: grant } };
  }
  return { servers, grant, proxied };
}

/** A proxy entry without its per-spawn url and grant: everything a session reads from it. */
export function proxiedShape(entry: CustomConnectorEntry): Record<string, unknown> {
  return { ...agentFacingFields(entry.config), type: entry.config.type };
}

/** A container's private channel for launcher upgrades and live authorization checks. */
function listenOnSocket(file: string): http.Server {
  try { fs.rmSync(file, { force: true }); } catch { /* bind reports it */ }
  const app = express();
  app.use(createConnectorProxyRouter());
  const server = http.createServer(app);
  server.on('upgrade', (req, socket, head) => { if (!handleConnectorUpgrade(req, socket, head)) socket.destroy(); });
  server.on('error', err => console.error(`connector-proxy: socket ${file} failed: ${err.message}`));
  server.listen(file, () => { try { fs.chmodSync(file, 0o600); } catch { /* removed already */ } });
  return server;
}

/** Remove launcher sockets in `dir` no live grant holds: a gateway that exited
 * without revoking (crash, SIGKILL) leaves them in the agent's workspace. */
export function sweepStaleSockets(dir: string): void {
  const live = new Set([...grants.values()].map(g => g.socket?.file));
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    const file = path.join(dir, name);
    if (!name.endsWith('.sock') || live.has(file)) continue;
    try { fs.rmSync(file, { force: true }); } catch (err) { console.warn(`connector-proxy: cannot remove stale socket ${file}: ${(err as Error).message}`); }
  }
}

export function revokeConnectorGrant(grant: string | undefined): void {
  if (!grant) return;
  const record = grants.get(grant);
  grants.delete(grant);
  clearRuntimeExposure(grant);
  if (!record) return;
  record.revoked = true;
  // Ending stdin lets a server exit on its own (a container bridge only sees EOF);
  // the signal covers one that does not.
  for (const bridge of record.bridges) {
    bridge.stdin?.end();
    setTimeout(() => bridge.kill('SIGTERM'), 2000).unref();
  }
  if (record.socket) {
    record.socket.server.close();
    try { fs.rmSync(record.socket.file, { force: true }); } catch { /* already gone */ }
  }
}

/** Loopback, or a same-host client that reached a non-loopback bind address. A
 * same-host reverse proxy also connects from loopback, so a request it forwarded
 * (it adds a forwarding header; an agent's MCP client never does) is refused too. */
function isSameHost(req: http.IncomingMessage): boolean {
  if (req.headers['x-forwarded-for'] !== undefined || req.headers['forwarded'] !== undefined) return false;
  const remote = req.socket.remoteAddress;
  // Only a unix socket has no remote address: a container's launcher socket.
  if (remote === undefined) return true;
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
  router.post(`${CONNECTOR_PROXY_PATH}/:id/authorize`, (req: Request, res: Response) => {
    if (!isSameHost(req)) { res.status(403).end(); return; }
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    const grant = match ? grants.get(match[1]) : undefined;
    if (!grant) { res.status(401).end(); return; }
    const id = req.params['id'] ?? '';
    if (grant.routes.get(id) !== 'launch') { res.status(403).end(); return; }
    let resolved: unknown;
    try { resolved = grant.resolve(id); }
    catch (err) { console.error(`connector-proxy: connector=${id} authorization check failed: ${(err as Error).message}`); }
    if (!bridgeable(resolved)) { res.status(403).end(); return; }
    res.status(204).end();
  });
  // A sidecar that is still starting has no url yet: hold the request until it
  // listens rather than failing a session that spawned alongside it.
  router.all(`${CONNECTOR_PROXY_PATH}/:id`, (req: Request, _res: Response, next: NextFunction) => {
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    const id = req.params['id'] ?? '';
    const sidecars = connectorSidecars.get();
    if (!match || !grants.has(match[1]) || !isSameHost(req) || !sidecars.statusOf(id) || sidecars.urlOf(id)) { next(); return; }
    sidecars.waitUntilReady(id).then(() => next(), () => next());
  });
  router.all(`${CONNECTOR_PROXY_PATH}/:id`, (req: Request, res: Response) => {
    if (!isSameHost(req)) { res.status(403).json({ error: 'Forbidden' }); return; }
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    const grant = match ? grants.get(match[1]) : undefined;
    if (!grant) { res.status(401).json({ error: 'Unauthorized' }); return; }
    const id = req.params['id'] ?? '';
    if (grant.routes.get(id) !== 'proxy') { res.status(403).json({ error: 'Forbidden' }); return; }
    if (!['GET', 'POST', 'DELETE'].includes(req.method)) { res.status(405).json({ error: 'Method not allowed' }); return; }
    let upstream: ReturnType<typeof upstreamOf>;
    try {
      const resolved = grant.resolve(id);
      upstream = upstreamOf(resolved);
      // Disconnected/disabled resolves to nothing, which is normal; a resolved entry
      // the proxy cannot use is a configuration error worth a line.
      if (resolved !== undefined && !upstream) console.error(`connector-proxy: connector=${id} has no usable http url/headers`);
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

    // Kept for replaying the body to a same-origin 307/308 target; dropped past the cap.
    let body: Buffer[] | undefined = [];
    let bodyBytes = 0;
    req.on('data', (chunk: Buffer) => {
      if (!body) return;
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_REPLAY_BYTES) body = undefined;
      else body.push(chunk);
    });
    const method = req.method;
    let outbound: http.ClientRequest | undefined;
    let clientGone = false;
    const send = (target: URL, hops: number): http.ClientRequest | undefined => {
      let request: http.ClientRequest;
      try {
        // node:http rather than fetch: undici's default 300s headers/body timeouts
        // would cut long tool calls and idle SSE streams the agent's client allows.
        request = (target.protocol === 'https:' ? https : http).request(target, { method, headers }, incoming => {
          const status = incoming.statusCode ?? 502;
          const location = incoming.headers.location;
          if (status >= 300 && status < 400 && location !== undefined) {
            incoming.resume();
            // Same-origin only (see redirect.ts), and only where the request can be
            // repeated unchanged: a bodyless method, or a 307/308 with its body kept.
            const next = sameOriginRedirect(target, location);
            const repeatable = method !== 'POST' || ((status === 307 || status === 308) && body !== undefined);
            if (!next || hops >= MAX_REDIRECTS || !repeatable || clientGone) {
              if (!next) console.error(`connector-proxy: connector=${id} refused a redirect to another origin`);
              if (!res.headersSent) res.status(502).json({ error: 'Upstream redirect refused' });
              return;
            }
            const follow = (): void => {
              if (clientGone) return;
              outbound = send(next, hops + 1);
              outbound?.end(method === 'POST' ? Buffer.concat(body!) : undefined);
            };
            if (req.readableEnded) follow(); else req.once('end', follow);
            return;
          }
          res.status(status);
          for (const name of FORWARDED_RESPONSE_HEADERS) {
            const value = incoming.headers[name];
            if (value !== undefined) res.setHeader(name, value);
          }
          res.flushHeaders();
          // pipeline, not pipe: an upstream that drops mid-response must end the
          // agent's stream too, or its call hangs on a response that never finishes.
          pipeline(incoming, res, err => {
            // `res.errored` tells an upstream failure from the agent cancelling the call.
            if (err && res.errored) console.error(`connector-proxy: connector=${id} response stream failed: ${err.message}`);
          });
        });
      } catch (err) {
        // An invalid header value in the pasted config throws synchronously.
        console.error(`connector-proxy: connector=${id} request rejected: ${(err as Error).message}`);
        if (!res.headersSent) res.status(502).json({ error: 'Upstream request failed' });
        return undefined;
      }
      request.on('error', err => {
        // Destroyed below because the agent cancelled first: nothing failed upstream.
        if (clientGone) return;
        console.error(`connector-proxy: connector=${id} upstream failed: ${err.message}`);
        if (!res.headersSent) res.status(502).json({ error: 'Upstream request failed' });
        else res.destroy();
      });
      return request;
    };
    outbound = send(upstream.url, 0);
    if (!outbound) return;
    // The agent's client went away (cancelled call, closed SSE stream): stop upstream too.
    res.on('close', () => {
      clientGone = !res.writableFinished;
      outbound?.destroy();
    });
    pipeline(req, outbound, () => { /* outbound errors are reported by its 'error' listener */ });
  });
  return router;
}

const MAX_PREAMBLE_BYTES = 1024 * 1024;

/** Whether the bridge can drive this resolved entry (mirrors connector-bridge.ts). */
function bridgeable(server: unknown): server is Record<string, unknown> {
  if (!server || typeof server !== 'object') return false;
  const { command, url, type } = server as Record<string, unknown>;
  if (typeof command === 'string') return true;
  return typeof url === 'string' && (type === 'sse' || isStreamableHttpType(type));
}

function stringEnv(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((pair): pair is [string, string] => typeof pair[1] === 'string'));
}

/**
 * A launcher's upgrade request (mcp/connector-launcher.mjs). Returns false when the
 * request is not for this route, so the server's other upgrade handlers can run.
 * After the 101 the socket carries one JSON line (the launcher's cwd and env), then
 * the MCP stdio stream in both directions, piped to and from a bridge process.
 */
export function handleConnectorUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const match = /^\/internal\/mcp\/connectors\/([^/?]+)\/stdio(?:\?.*)?$/.exec(req.url ?? '');
  if (!match) return false;
  const refuse = (status: string): true => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); return true; };
  socket.on('error', () => {});
  if (String(req.headers.upgrade ?? '').toLowerCase() !== LAUNCH_PROTOCOL) return refuse('400 Bad Request');
  if (!isSameHost(req)) return refuse('403 Forbidden');
  const auth = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
  const grant = auth ? grants.get(auth[1]) : undefined;
  if (!auth || !grant) return refuse('401 Unauthorized');
  let id: string;
  try { id = decodeURIComponent(match[1]); } catch { return refuse('400 Bad Request'); }
  if (!grant.routes.has(id)) return refuse('403 Forbidden');
  let config: unknown;
  try {
    config = grant.resolve(id);
    if (config !== undefined && !bridgeable(config)) console.error(`connector-proxy: connector=${id} has no usable command or url`);
  } catch (err) {
    console.error(`connector-proxy: connector=${id} resolve failed: ${(err as Error).message}`);
  }
  if (!bridgeable(config)) return refuse('403 Forbidden');
  const server = config;

  socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: ${LAUNCH_PROTOCOL}\r\n\r\n`);
  let pending = head;
  const onData = (chunk: Buffer): void => {
    pending = Buffer.concat([pending, chunk]);
    const end = pending.indexOf(10);
    if (end < 0) {
      if (pending.length > MAX_PREAMBLE_BYTES) socket.destroy();
      return;
    }
    socket.off('data', onData);
    socket.pause();
    let preamble: { cwd?: unknown; env?: unknown } = {};
    try { preamble = JSON.parse(pending.subarray(0, end).toString('utf8')); } catch { socket.destroy(); return; }
    startBridge(grant, auth[1], id, server, preamble, pending.subarray(end + 1), socket);
  };
  socket.on('data', onData);
  if (head.length) onData(Buffer.alloc(0));
  return true;
}

/** Per-bridge cap on stderr copied to the gateway log; a server stuck in a log
 * loop must not fill the disk. */
const MAX_STDERR_LOG_BYTES = 256 * 1024;
const MAX_STDERR_LINE = 4096;

/**
 * Copy a launched server's stderr (and the bridge's own) to the gateway log, line by
 * line as it arrives. Claude Code used to keep it in its per-server MCP log; with the
 * server running under the gateway, this log is where it now goes.
 */
function logBridgeStderr(bridge: ChildProcess, prefix: string): void {
  let partial = '';
  let logged = 0;
  const emit = (line: string): void => {
    if (!line.trim() || logged > MAX_STDERR_LOG_BYTES) return;
    logged += line.length;
    console.error(`${prefix} stderr: ${line.slice(0, MAX_STDERR_LINE)}`);
    if (logged > MAX_STDERR_LOG_BYTES) console.error(`${prefix} stderr: further output suppressed`);
  };
  bridge.stderr!.on('data', (chunk: Buffer) => {
    const lines = (partial + chunk.toString('utf8')).split('\n');
    partial = lines.pop() ?? '';
    if (partial.length > MAX_STDERR_LINE) { emit(partial); partial = ''; }
    for (const line of lines) emit(line);
  });
  bridge.stderr!.on('end', () => { emit(partial); partial = ''; });
}

function startBridge(grant: Grant, grantToken: string, id: string, server: Record<string, unknown>, preamble: { cwd?: unknown; env?: unknown }, rest: Buffer, socket: Duplex): void {
  if (grant.revoked) { socket.destroy(); return; }
  const clean = grant.cleanEnv;
  // Connector env is explicit connector configuration and remains available. Only
  // the launcher's inherited environment is unrelated agent/process state.
  const config = server;
  const authPath = `${CONNECTOR_PROXY_PATH}/${encodeURIComponent(id)}/authorize`;
  const spec = {
    config,
    cwd: typeof preamble.cwd === 'string' && preamble.cwd.startsWith('/') ? preamble.cwd : undefined,
    env: clean(stringEnv(preamble.env)),
    authorization: grant.container
      ? { socketPath: path.join(grant.container.containerDir, path.basename(grant.socket?.file ?? '')), path: authPath, grant: grantToken }
      : { url: `${proxyBaseUrl()}${authPath}`, grant: grantToken },
  };
  const bridge = grant.container
    ? spawn('docker', ['exec', '-i', '--user', String(userInfo().uid), grant.container.container, 'node', '-e', CONTAINER_BRIDGE_LOADER], { stdio: ['pipe', 'pipe', 'pipe'] })
    // Its own environment carries nothing of the gateway's: the server's comes from the spec.
    : spawn('bun', [BRIDGE], { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  grant.bridges.add(bridge);
  logBridgeStderr(bridge, `connector-proxy: agent=${grant.agentId} connector=${id}`);
  bridge.stdin!.on('error', () => {});
  if (grant.container) bridge.stdin!.write(JSON.stringify(grant.container.bridgeCode) + '\n');
  bridge.stdin!.write(JSON.stringify(spec) + '\n');
  if (rest.length) bridge.stdin!.write(rest);
  socket.pipe(bridge.stdin!);
  socket.resume();
  bridge.stdout!.pipe(socket);
  bridge.on('error', err => { console.error(`connector-proxy: connector=${id} bridge failed: ${err.message}`); socket.destroy(); });
  bridge.on('exit', (code, signal) => {
    grant.bridges.delete(bridge);
    if (code) console.error(`connector-proxy: agent=${grant.agentId} connector=${id} exited code=${code}`);
    else if (signal && signal !== 'SIGTERM') console.error(`connector-proxy: connector=${id} killed by ${signal}`);
  });
  bridge.stdout!.on('end', () => socket.end());
  // The launcher went away (its client stopped the server): end the bridge the same way.
  socket.on('close', () => {
    bridge.stdin!.end();
    setTimeout(() => { if (bridge.exitCode === null) bridge.kill('SIGTERM'); }, 2000).unref();
  });
}
