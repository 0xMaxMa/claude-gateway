#!/usr/bin/env node
// Opt-in native CLI regression: local mock Responses only; no provider credits.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert/strict');
const { spawn } = require('child_process');
const { buildNativeInvocation } = require('../../dist/safemode/native');

(async () => {
  const cache = path.join(os.homedir(), '.cache');
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, 'safemode-policy-'));
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(cwd);
  const marker = path.join(root, 'unexpected-notify');
  const hook = path.join(root, 'notify.cjs');
  fs.writeFileSync(hook, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`);
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    for await (const chunk of req) { /* Drain local fixture input. */ }
    if (!req.url.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
    requests++;
    const item = { type: 'message', id: 'msg_fixture', role: 'assistant', phase: 'final_answer', status: 'completed', content: [{ type: 'output_text', text: 'Fixture complete', annotations: [] }] };
    const response = { id: 'resp_fixture', object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: 'gpt-test', output: [item], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [type, payload] of [
      ['response.created', { response: { ...response, status: 'in_progress', output: [] } }],
      ['response.output_item.added', { output_index: 0, item }],
      ['response.output_item.done', { output_index: 0, item }],
      ['response.completed', { response }],
    ]) res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...payload }) + '\n\n');
    res.end();
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    fs.writeFileSync(path.join(root, 'config.toml'), `model="gpt-test"\nmodel_provider="fixture"\nnotify=[${JSON.stringify(process.execPath)},${JSON.stringify(hook)}]\n[features]\nhooks=true\nplugins=true\napps=true\n[model_providers.fixture]\nname="fixture"\nbase_url="http://127.0.0.1:${server.address().port}/v1"\nwire_api="responses"\nenv_key="FIXTURE_KEY"\n`);
    const env = { ...process.env, CODEX_HOME: root, FIXTURE_KEY: 'fake-local-only' };
    async function run(nativeSessionId) {
      const inv = buildNativeInvocation({ cli: 'codex', mode: 'headless', cwd, env, nativeSessionId, resume: Boolean(nativeSessionId), prompt: 'Reply fixture complete without tools.' });
      const output = await new Promise((resolve, reject) => {
        const child = spawn(inv.command, inv.args, { cwd, env: { ...inv.env, FIXTURE_KEY: 'fake-local-only' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let text = '', error = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
        child.stdout.on('data', chunk => { text += chunk; });
        child.stderr.on('data', chunk => { error += chunk; });
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(text) : reject(new Error(`Native exit ${code}: ${error}`)); });
      });
      const events = output.trim().split('\n').map(line => JSON.parse(line));
      assert(events.some(event => event.type === 'turn.completed'));
      const id = events.find(event => event.type === 'thread.started')?.thread_id;
      assert(id); if (nativeSessionId) assert.equal(id, nativeSessionId);
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal(fs.existsSync(marker), false, 'notify executed outside the read-only workspace');
      return id;
    }
    await run(await run());
    assert.equal(requests, 2);
    console.log('PASS native Codex safemode: fresh and resumed turns complete; inherited notify never executes');
  } finally {
    server.closeAllConnections(); server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
