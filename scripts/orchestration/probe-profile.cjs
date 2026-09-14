#!/usr/bin/env node
// Opt-in live P0 probe. Only disposable workspace data enters the prompt.
const { mkdtempSync, writeFileSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { loadWorkspace } = require('../../dist/agent/workspace-loader');
const { SessionStore } = require('../../dist/session/store');
const { runtimeProfileArgs, AGENT_OVERLAY } = require('../../dist/session/runtime-profile');
(async () => {
  const root = mkdtempSync(join(tmpdir(), 'gateway-orchestration-probe-'));
  const workspace = join(root, 'probe', 'workspace');
  mkdirSync(workspace, { recursive: true });
  for (const [file, content] of Object.entries({
    'AGENTS.md': 'You are a disposable conversation profile test fixture.',
    'IDENTITY.md': 'Your fixture identity is CitrineHeron.',
    'SOUL.md': 'Be concise and truthful.',
    'USER.md': 'The fixture user prefers Thai.',
    'MEMORY.md': 'The fixture project codeword is cobalt-orchid.',
  })) writeFileSync(join(workspace, file), content);
  const loaded = await loadWorkspace(workspace);
  mkdirSync(join(workspace, 'memory'));
  writeFileSync(join(workspace, 'memory', 'fixture.md'), 'Archived marker: silver-pine.');
  writeFileSync(join(workspace, 'CLAUDE.md'), loaded.systemPrompt);
  const sessionId = randomUUID();
  const store = new SessionStore(root);
  await store.appendMessage('probe', sessionId, { role: 'user', content: 'Our previous fixture choice was amber-bridge.', ts: Date.now() });
  const history = await store.loadSession('probe', sessionId);
  const mcpConfigPath = join(root, 'mcp.json');
  writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { gateway: { command: 'bun',
    args: [resolve(__dirname, '../../mcp/server.ts')],
    env: { GATEWAY_ORCHESTRATION_ROLE: 'agent', GATEWAY_WORKSPACE_DIR: workspace, GATEWAY_ORCHESTRATION_TICKET_FILE: join(root, 'unused-ticket.json') },
  } } }));
  const args = ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--include-partial-messages', '--session-id', sessionId, '--dangerously-skip-permissions',
    ...runtimeProfileArgs({ role: 'agent', mcpConfigPath, overlay: AGENT_OVERLAY, context: loaded.systemPrompt }, [])];
  const child = spawn('claude', args, { cwd: workspace, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', stderr = '', inventory, result;
  const timer = setTimeout(() => child.kill('SIGTERM'), 45000);
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const event = JSON.parse(line);
        if (event.type === 'system' && event.subtype === 'init') inventory = { tools: event.tools, mcp_servers: event.mcp_servers, session_id: event.session_id };
        if (event.type === 'result') { result = { subtype: event.subtype, result: event.result, is_error: event.is_error }; child.stdin.end(); }
      } catch {}
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: `Fixture history: ${JSON.stringify(history)}\nWhat are your fixture identity, project codeword and previous choice? Use memory_get to retrieve memory/fixture.md and report its archived marker. State whether Read or Bash tools are available; do not create any tasks.` } }) + '\n');
  child.stdin.end();
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    const report = { cli: execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim(), backend: 'headless', workspace, sessionId,
      inventory, result, exitCode: code, signal, stderrPresent: Boolean(stderr),
      contextPassed: Boolean(result?.result && ['CitrineHeron', 'cobalt-orchid', 'amber-bridge', 'silver-pine'].every(s => result.result.includes(s))),
      inventoryPassed: Array.isArray(inventory?.tools) && inventory.tools.length === 7 && inventory.tools.every(name => /^mcp__gateway__(task_(spawn|status|cancel|update|answer)|memory_(search|get))$/.test(name)) };
    const target = process.argv[2];
    if (target) writeFileSync(resolve(target), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.contextPassed && report.inventoryPassed && code === 0 ? 0 : 1;
  });
})().catch(error => { console.error(error.message); process.exitCode = 1; });
