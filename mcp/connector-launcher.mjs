#!/usr/bin/env node
/**
 * Agent-side half of a launched connector (#635). Claude Code (or lazy-connector.ts)
 * starts this as the connector's stdio MCP server. It holds no secret: it opens a
 * grant-authenticated upgrade to the gateway, sends the cwd and environment it was
 * started with, then passes stdin/stdout through unchanged. The gateway runs the
 * real server (or SSE/HTTP client) with the resolved entry it never writes to disk.
 *
 * Plain Node with no dependencies, so the same file runs inside an app-agent container.
 */
import * as http from 'node:http';

const PROTOCOL = 'gateway-connector-stdio';
const { GATEWAY_CONNECTOR_URL: url, GATEWAY_CONNECTOR_SOCKET: socketPath, GATEWAY_CONNECTOR_PATH: path, GATEWAY_CONNECTOR_GRANT: grant } = process.env;
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GATEWAY_CONNECTOR_')));

function fail(message) {
  process.stderr.write(`connector-launcher: ${message}\n`);
  process.exit(1);
}

if (!grant || !(url || (socketPath && path))) fail('missing gateway connector address');

// A container's socket is bound as its session starts; give it a moment to appear.
const deadline = Date.now() + 5000;
function open() {
  const headers = { connection: 'Upgrade', upgrade: PROTOCOL, authorization: `Bearer ${grant}` };
  const req = socketPath ? http.request({ socketPath, path, headers }) : http.request(new URL(url), { headers });
  req.on('upgrade', (_res, socket, head) => {
    socket.write(JSON.stringify({ cwd: process.cwd(), env }) + '\n');
    if (head.length) process.stdout.write(head);
    socket.pipe(process.stdout);
    process.stdin.pipe(socket);
    socket.on('end', () => process.exit(0));
    socket.on('error', err => fail(err.message));
  });
  req.on('response', res => fail(`gateway refused the connector (${res.statusCode})`));
  req.on('error', err => {
    if ((err.code === 'ENOENT' || err.code === 'ECONNREFUSED') && Date.now() < deadline) setTimeout(open, 100);
    else fail(err.message);
  });
  req.end();
}
open();
