#!/usr/bin/env node
// Real Claude CLI with a local image-service fixture; no live image-provider claim.
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { loadWorkspace } = require('../../dist/agent/workspace-loader');
const { SessionStore } = require('../../dist/session/store');
const { SessionProcess } = require('../../dist/session/process');
const { HistoryDB } = require('../../dist/history/db');
const { AgentOrchestrationRuntime } = require('../../dist/orchestration/runtime');
(async () => {
  const root = mkdtempSync(join(tmpdir(), 'gateway-orchestration-media-'));
  const agentDir = join(root, 'agents', 'probe'), workspace = join(agentDir, 'workspace'), project = join(root, 'fixture-project');
  mkdirSync(workspace, { recursive: true }); mkdirSync(project);
  for (const [file, value] of Object.entries({ 'AGENTS.md': 'You are an engineering assistant. Follow the agent role.',
    'IDENTITY.md': 'Name: CitrineHeron', 'SOUL.md': 'Be concise.', 'MEMORY.md': 'Project codeword: cobalt-orchid.' })) writeFileSync(join(workspace, file), value);
  const loaded = await loadWorkspace(workspace); writeFileSync(join(workspace, 'CLAUDE.md'), loaded.systemPrompt);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3xkAAAAASUVORK5CYII=';
  let generated = 0;
  const imageServer = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume the fixture request */ }
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') { generated++; res.statusCode = 202; res.end(JSON.stringify({ task_id: 'fixture-job', status: 'queued' })); }
    else if (req.url.includes('/jobs/')) res.end(JSON.stringify({ task_id: 'fixture-job', status: 'done', provider: 'fixture', model: 'fixture-image', images: [png] }));
    else res.end(JSON.stringify({ data: [{ id: 'fixture-image', type: 'image', supports_image_ref: false }] }));
  });
  imageServer.listen(0, '127.0.0.1'); await once(imageServer, 'listening');
  process.env.IMAGE_BASE_URL = `http://127.0.0.1:${imageServer.address().port}`;
  process.env.IMAGE_API_KEY = 'fixture-only';
  const agent = { id: 'probe', description: 'real CLI with fixture image provider', workspace, env: '', claude: { model: process.env.ORCHESTRATION_SMOKE_MODEL || 'sonnet', extraFlags: [] },
    orchestration: { enabled: true, conversation: { decisionTimeoutMs: 45000 }, tasks: { defaultTimeoutMs: 120000 } } };
  const gateway = { gateway: { orchestration: true, headless: true, logDir: join(root, 'logs'), timezone: 'UTC' }, agents: [agent] };
  const sessions = new SessionStore(join(root, 'agents')), history = HistoryDB.forDir(agentDir, 'probe');
  let runtime;
  const host = { createAgentSession: async (sessionId, profile) => new SessionProcess(sessionId, 'api', agent, gateway, sessions, undefined, profile), releaseAgentSession: async (_, p) => p.stop() };
  const report = { root, cli: execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim(), events: [] };
  try {
    runtime = await AgentOrchestrationRuntime.open(agent, gateway, agentDir, sessions, history, host);
    const scope = { agentId: 'probe', agentSessionId: randomUUID(), source: 'api', accountId: 'fixture', chatId: 'fixture', threadKey: '', principalId: 'fixture' };
    const send = async text => {
      const start = Date.now();
      const answer = await runtime.send({ scope, text, requestId: randomUUID() }, { execute: true, writeMemory: false }, { timeoutMs: 45000 });
      report.events.push({ answer, durationMs: Date.now() - start });
    };
    await send('Create exactly one media-worker task: use generate_image with model fixture-image and prompt a tiny red square, then task_stage_file on the generated file. Also create a document named receipt.txt containing exactly DOCUMENT_FIXTURE_OK and stage it. Do not use a project repository. Queue now and end the response.');
    report.afterDispatch = runtime.store.all('SELECT state,snapshot_json FROM tasks').map(r => JSON.parse(r.snapshot_json));
    await send('What is your name and our project codeword? Also report the current task status from the saved snapshot.');
    report.afterFollowup = runtime.store.all('SELECT state,snapshot_json FROM tasks').map(r => JSON.parse(r.snapshot_json));
    const deadline = Date.now() + 140000;
    while (Date.now() < deadline) {
      const task = runtime.store.all('SELECT snapshot_json FROM tasks').map(r => JSON.parse(r.snapshot_json))[0];
      if (!task || ['completed', 'failed', 'needs_reconciliation', 'cancelled'].includes(task.state)) { report.task = task; break; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    await send('Report the task result and actual test evidence.');
    const paths = runtime.responseFiles(scope.agentSessionId);
    report.attachments = paths;
    report.generatedCalls = generated;
    const buffers = paths.map(ref => readFileSync(join(agentDir, ref)));
    report.imageBytesMatch = buffers.some(bytes => bytes.equals(Buffer.from(png, 'base64')));
    report.documentBytesMatch = buffers.some(bytes => bytes.toString().trim() === 'DOCUMENT_FIXTURE_OK');
    report.pass = report.task?.state === 'completed' && paths.length === 2 && report.imageBytesMatch && report.documentBytesMatch && generated === 1;
  } catch (error) { report.error = { message: error.message, code: error.code }; }
  finally { await runtime?.close(); await new Promise(resolve => imageServer.close(resolve)); writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
  process.exit(report.pass ? 0 : 1);
})().catch(error => { console.error(error.message); process.exit(1); });
