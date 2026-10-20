/**
 * Gateway-side half of a launched connector (#635). The gateway spawns this per
 * launcher connection and writes one JSON line first: the resolved mcpServers entry
 * plus the launcher's cwd and environment. Everything after it is the agent's MCP
 * stdio stream. The secret therefore travels over a pipe and never reaches a file,
 * this process's argv or its environment.
 *
 *   stdio entry   spawn the server exactly as Claude Code would (launcher env + entry
 *                 env, launcher cwd) and hand it the stream byte for byte
 *   sse / http    forward each JSON-RPC message to the upstream with the entry's headers,
 *                 following same-origin redirects only (src/connectors/redirect.ts),
 *                 the same policy as the gateway's HTTP proxy
 *
 * Bundled for Node when it has to run inside an app-agent container.
 */
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { PassThrough } from 'stream';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MAX_REDIRECTS, sameOriginRedirect } from '../src/connectors/redirect';

const MAX_SPEC_BYTES = 4 * 1024 * 1024;
let pending = Buffer.alloc(0);

function onData(chunk: Buffer): void {
  pending = Buffer.concat([pending, chunk]);
  const end = pending.indexOf(10);
  if (end < 0) {
    if (pending.length > MAX_SPEC_BYTES) fail('connector spec too large');
    return;
  }
  process.stdin.off('data', onData);
  process.stdin.pause();
  let spec: { config: Record<string, any>; cwd?: string; env?: Record<string, string> };
  try { spec = JSON.parse(pending.subarray(0, end).toString('utf8')); } catch { return fail('invalid connector spec'); }
  // The rest of the stream, starting with whatever arrived alongside the spec.
  const rest = new PassThrough();
  rest.write(pending.subarray(end + 1));
  process.stdin.pipe(rest);
  pending = Buffer.alloc(0);
  if (typeof spec.config?.command === 'string') runStdio(spec as any, rest);
  else runRemote(spec.config, rest).catch(err => fail(err instanceof Error ? err.message : String(err)));
}

function fail(message: string): never {
  process.stderr.write(`connector-bridge: ${message}\n`);
  process.exit(1);
}

function runStdio(spec: { config: { command: string; args?: unknown; env?: Record<string, string>; cwd?: string }; cwd?: string; env?: Record<string, string> }, input: PassThrough): void {
  const { config } = spec;
  const child = spawn(config.command, Array.isArray(config.args) ? config.args.map(String) : [], {
    cwd: typeof config.cwd === 'string' ? config.cwd : spec.cwd,
    env: { ...spec.env, ...config.env },
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  child.stdin.on('error', () => {});
  input.pipe(child.stdin);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => child.kill(signal));
  child.on('error', err => fail(`cannot start ${config.command}: ${err.message}`));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

/**
 * fetch with the connector's redirect policy. Same-origin hops keep fetch's own
 * method rules (303, and 301/302 after a POST, continue as a bodyless GET); a hop to
 * another origin fails the request instead of carrying the headers there.
 */
async function sameOriginFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  let url = new URL(input instanceof Request ? input.url : String(input));
  let current: RequestInit = { ...init, redirect: 'manual' };
  for (let hop = 0; ; hop++) {
    const res = await fetch(url, current);
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || location === null) return res;
    const next = sameOriginRedirect(url, location);
    await res.body?.cancel();
    if (!next) throw new Error(`upstream redirect to another origin refused (${res.status})`);
    if (hop >= MAX_REDIRECTS) throw new Error('too many upstream redirects');
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && current.method === 'POST')) {
      current = { ...current, method: 'GET', body: undefined };
    }
    url = next;
  }
}

async function runRemote(config: Record<string, any>, input: PassThrough): Promise<void> {
  const url = new URL(config.url);
  const requestInit = { headers: config.headers ?? {} };
  const transport = config.type === 'sse'
    ? new SSEClientTransport(url, { requestInit, fetch: sameOriginFetch })
    : new StreamableHTTPClientTransport(url, { requestInit, fetch: sameOriginFetch });
  const initializing = new Set<unknown>();
  transport.onmessage = (message: any) => {
    // Claude Code's own transport sends the negotiated version on later requests.
    if (initializing.delete(message.id) && message.result?.protocolVersion && 'setProtocolVersion' in transport) {
      (transport as StreamableHTTPClientTransport).setProtocolVersion(message.result.protocolVersion);
    }
    process.stdout.write(JSON.stringify(message) + '\n');
  };
  transport.onerror = err => process.stderr.write(`connector-bridge: ${err.message}\n`);
  transport.onclose = () => process.exit(0);
  await transport.start();
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on('line', line => {
    if (!line.trim()) return;
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method === 'initialize') initializing.add(message.id);
    transport.send(message).catch((err: Error) => {
      // A request that never reached the upstream still needs an answer, or the call hangs.
      if (message.id !== undefined && message.method) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: err.message } }) + '\n');
      }
    });
  });
  lines.on('close', () => { void transport.close(); });
}

// resume(): a loader that read this module's code off stdin first leaves it paused.
process.stdin.on('data', onData).resume();
process.stdin.on('end', () => { if (pending.length) fail('connector spec incomplete'); });
