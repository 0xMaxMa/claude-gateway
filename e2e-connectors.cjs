/* Real e2e for the connectors feature — uses the COMPILED dist modules, a real
 * HTTP server on a test port, real files in a temp HOME. No systemd, no mocks. */
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-e2e-'));
const tokenEnv = path.join(tmp, 'mcp-token.env');
const configPath = path.join(tmp, 'config.json');
process.env.GATEWAY_MCP_TOKEN_ENV = tokenEnv;
fs.writeFileSync(configPath, JSON.stringify({ gateway: { logDir: '/tmp', timezone: 'UTC' }, agents: [] }, null, 2));

const { createConnectorsRouter } = require('./dist/api/connectors-router');
const { resolveEnabledConnectors } = require('./dist/connectors/resolve');

const ADMIN = 'admin-key-e2e';
const apiKeys = [{ key: ADMIN, agents: '*', admin: true }];

const app = express();
app.use(express.json());
app.use('/api', createConnectorsRouter(apiKeys, configPath));
const server = app.listen(19099);

const TOKEN = process.env.E2E_GH_TOKEN || 'ghp_dummy_e2e_test_token';
const base = 'http://127.0.0.1:19099/api/v1';
const H = { 'Content-Type': 'application/json', 'X-Api-Key': ADMIN };
const log = (...a) => console.log(...a);

(async () => {
  try {
    log('\n=== 1. GET /connectors (catalog, before connect) ===');
    let r = await fetch(`${base}/connectors`, { headers: H });
    log('status', r.status, JSON.stringify(await r.json()));

    log('\n=== 2. auth: missing key rejected ===');
    r = await fetch(`${base}/connectors`);
    log('no key ->', r.status);

    log('\n=== 3. POST /connectors/github/connect (real token write) ===');
    r = await fetch(`${base}/connectors/github/connect`, { method: 'POST', headers: H, body: JSON.stringify({ token: TOKEN }) });
    log('status', r.status, JSON.stringify(await r.json()));

    log('\n=== 4. real files on disk ===');
    log('mcp-token.env:', JSON.stringify(fs.readFileSync(tokenEnv, 'utf-8')));
    log('mode:', '0' + (fs.statSync(tokenEnv).mode & 0o777).toString(8));
    log('config.json gateway.connectors:', JSON.stringify(JSON.parse(fs.readFileSync(configPath, 'utf-8')).gateway.connectors));

    log('\n=== 5. GET status ===');
    r = await fetch(`${base}/connectors/github/status`, { headers: H });
    log('status', r.status, JSON.stringify(await r.json()));

    log('\n=== 6. INJECTION: what a session would get (resolveEnabledConnectors) ===');
    const injected = resolveEnabledConnectors({ connectors: { github: { enabled: true } } });
    log(JSON.stringify(injected, null, 2));
    const disabled = resolveEnabledConnectors({ connectors: {} });
    log('disabled agent ->', JSON.stringify(disabled));

    log('\n=== 7. REAL GitHub MCP reachability with the connected token ===');
    const ghEntry = injected.github;
    const mcpInit = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } } };
    const gr = await fetch(ghEntry.url, { method: 'POST', headers: { ...ghEntry.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(mcpInit) });
    log('GitHub MCP status:', gr.status);
    log('www-authenticate:', gr.headers.get('www-authenticate') || '(none)');
    const bodyText = (await gr.text()).slice(0, 300);
    log('body (first 300):', bodyText.replace(/\n/g, ' '));

    log('\n=== 8. DELETE /connectors/github (disconnect) ===');
    r = await fetch(`${base}/connectors/github`, { method: 'DELETE', headers: H });
    log('status', r.status, JSON.stringify(await r.json()));
    log('mcp-token.env after delete:', JSON.stringify(fs.readFileSync(tokenEnv, 'utf-8')));
    log('config.json connectors after delete:', JSON.stringify(JSON.parse(fs.readFileSync(configPath, 'utf-8')).gateway.connectors));

    log('\n=== DONE ===');
  } catch (e) {
    console.error('E2E ERROR:', e);
    process.exitCode = 1;
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
