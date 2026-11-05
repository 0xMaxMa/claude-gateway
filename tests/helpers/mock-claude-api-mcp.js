#!/usr/bin/env node
/**
 * Mock claude for API sessions that uses the gateway's real MCP server. It spawns the server named "gateway" from
 * --mcp-config, then answers each stream-json user turn by calling the tools the turn asks for:
 *   MCP-ATTACH:<absolute path>   -> api_reply { files: [path] }
 *   MCP-SHARE:<media path>       -> share_file { path }
 * Every tool result is appended as a JSON line to $MOCK_MCP_LOG.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const readline = require('readline');

const argv = process.argv.slice(2);
const configPath = argv[argv.indexOf('--mcp-config') + 1];
const log = (entry) => process.env.MOCK_MCP_LOG && fs.appendFileSync(process.env.MOCK_MCP_LOG, JSON.stringify(entry) + '\n');

process.on('uncaughtException', (e) => { log({ uncaught: String(e && e.stack) }); process.exit(1); });
process.on('unhandledRejection', (e) => { log({ unhandled: String(e && e.stack) }); });
let proc;
let buf = '';
let seq = 0;
const pending = new Map();
const send = (msg) => proc.stdin.write(JSON.stringify(msg) + '\n');
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 20000);
    pending.set(id, { resolve, reject, timer });
    send({ jsonrpc: '2.0', id, method, params });
  });

const ready = (async () => {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers.gateway;
  proc = spawn(cfg.command, cfg.args || [], { env: { ...process.env, ...(cfg.env || {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stderr.on('data', (d) => log({ stderr: String(d).slice(0, 600) }));
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        const p = msg.id != null && pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          clearTimeout(p.timer);
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        }
      } catch {}
    }
  });
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mock', version: '1' } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
})();

readline.createInterface({ input: process.stdin, terminal: false }).on('line', async (line) => {
  if (!line.trim()) return;
  let text = line;
  try { text = JSON.parse(line)?.message?.content?.[0]?.text ?? line; } catch {}
  try {
    await ready;
    for (const m of text.matchAll(/MCP-ATTACH:(\S+)/g)) {
      log({ tool: 'api_reply', result: await request('tools/call', { name: 'api_reply', arguments: { files: [m[1]] } }) });
    }
    for (const m of text.matchAll(/MCP-SHARE:(\S+)/g)) {
      log({ tool: 'share_file', result: await request('tools/call', { name: 'share_file', arguments: { path: m[1] } }) });
    }
  } catch (err) {
    log({ error: err.message });
  }
  process.stdout.write(JSON.stringify({ type: 'result', result: 'done' }) + '\n');
});

process.on('SIGTERM', () => { try { proc && proc.kill(); } catch {} process.exit(0); });
process.stdin.resume();
