#!/usr/bin/env node
// Live, disposable text orchestration smoke. Requires an authenticated Claude CLI.
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { loadWorkspace } = require('../../dist/agent/workspace-loader');
const { SessionStore } = require('../../dist/session/store');
const { SessionProcess } = require('../../dist/session/process');
const { HistoryDB } = require('../../dist/history/db');
const { loadSkills } = require('../../dist/skills/loader');
const { AgentOrchestrationRuntime } = require('../../dist/orchestration/runtime');
(async () => {
  const root = mkdtempSync(join(tmpdir(), 'gateway-orchestration-live-'));
  const agentDir = join(root, 'agents', 'probe'), workspace = join(agentDir, 'workspace'), project = join(root, 'fixture-project');
  mkdirSync(workspace, { recursive: true }); mkdirSync(project);
  for (const [file, value] of Object.entries({ 'AGENTS.md': 'You are an engineering assistant. Follow the agent role.',
    'IDENTITY.md': 'Name: CitrineHeron', 'SOUL.md': 'Be concise.', 'MEMORY.md': 'Project codeword: cobalt-orchid.' })) writeFileSync(join(workspace, file), value);
  const skillDir = join(workspace, 'skills', 'orchestration-proof'); mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: orchestration-proof\ndescription: Verify an isolated worker skill invocation\n---\nUse Bash to write SKILL_EXECUTED_$ARGUMENTS into skill-proof.txt in your working directory. Stage that file with task_stage_file and report its contents. The arguments are $ARGUMENTS.');
  const registry = loadSkills({ workspaceDir: workspace });
  const loaded = await loadWorkspace(workspace); writeFileSync(join(workspace, 'CLAUDE.md'), loaded.systemPrompt);
  execFileSync('git', ['init', '-q', project]);
  writeFileSync(join(project, 'sum.js'), 'module.exports = (a, b) => a - b;\n');
  writeFileSync(join(project, 'test.cjs'), "const assert = require('node:assert/strict'); assert.equal(require('./sum')(2, 3), 5); console.log('sum test passed');\n");
  execFileSync('git', ['-C', project, 'add', '.']);
  execFileSync('git', ['-C', project, '-c', 'user.name=Orchestration fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const agent = { id: 'probe', description: 'live smoke', workspace, env: '', claude: { model: process.env.ORCHESTRATION_SMOKE_MODEL || 'sonnet', extraFlags: [] },
    orchestration: { enabled: true, conversation: { decisionTimeoutMs: 45000 }, tasks: { projectRoot: project, defaultTimeoutMs: 90000 } } };
  const gateway = { gateway: { orchestration: true, headless: true, logDir: join(root, 'logs'), timezone: 'UTC' }, agents: [agent] };
  const sessions = new SessionStore(join(root, 'agents')), history = HistoryDB.forDir(agentDir, 'probe');
  let runtime;
  const host = { skills: () => registry, createAgentSession: async (sessionId, profile) => new SessionProcess(sessionId, 'api', agent, gateway, sessions, undefined, profile), releaseAgentSession: async (_, p) => p.stop() };
  const report = { root, cli: execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim(), events: [] };
  try {
    runtime = await AgentOrchestrationRuntime.open(agent, gateway, agentDir, sessions, history, host);
    const scope = { agentId: 'probe', agentSessionId: randomUUID(), source: 'api', accountId: 'fixture', chatId: 'fixture', threadKey: '', principalId: 'fixture' };
    const send = async text => {
      const start = Date.now();
      const answer = await runtime.send({ scope, text, requestId: randomUUID() }, { execute: true, writeMemory: false }, { timeoutMs: 45000 });
      report.events.push({ answer, durationMs: Date.now() - start });
    };
    await send('Create one task using default-worker: fix sum.js to add correctly, run node test.cjs, and report the diff and test output. Tell the worker to wait 12 seconds before editing so I can ask a follow-up. Queue it now and finish your response without waiting.');
    report.afterDispatch = runtime.store.all('SELECT state,snapshot_json FROM tasks').map(r => JSON.parse(r.snapshot_json));
    await send('What is your name and our project codeword? Also report the current task status from the saved snapshot.');
    report.afterFollowup = runtime.store.all('SELECT state,snapshot_json FROM tasks').map(r => JSON.parse(r.snapshot_json));
    const deadline = Date.now() + 100000;
    while (Date.now() < deadline) {
      const task = runtime.store.all('SELECT snapshot_json FROM tasks').map(r => JSON.parse(r.snapshot_json))[0];
      if (!task || ['completed', 'failed', 'needs_reconciliation', 'cancelled'].includes(task.state)) { report.task = task; break; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    await send('Report the task result and actual test evidence.');
    report.sourceProjectUnchanged = readFileSync(join(project, 'sum.js'), 'utf8').includes('a - b');
    const resource = report.task && runtime.store.get('SELECT worktree_path FROM task_resources WHERE task_id=?', report.task.taskId);
    if (resource) {
      report.independentTestOutput = execFileSync(process.execPath, [join(resource.worktree_path, 'test.cjs')], { encoding: 'utf8', timeout: 10000 }).trim();
      report.diff = execFileSync('git', ['-C', resource.worktree_path, 'diff', '--', 'sum.js'], { encoding: 'utf8' });
    }
    const skillStart = Date.now();
    await send('/orchestration-proof 465');
    const skillRow = runtime.store.get("SELECT snapshot_json FROM tasks WHERE json_extract(snapshot_json,'$.skill.name')='orchestration-proof'");
    const skillTask = skillRow && JSON.parse(skillRow.snapshot_json);
    report.skillAdmissionMs = Date.now() - skillStart;
    await new Promise(resolve => setTimeout(resolve, 250));
    report.skillStateBeforeFollowup = runtime.store.task(skillTask.taskId).state;
    await send('While the skill runs, briefly confirm that you can still chat. Do not wait or dispatch more work.');
    const skillDeadline = Date.now() + 100000;
    while (skillTask && Date.now() < skillDeadline) {
      report.skillTask = runtime.store.task(skillTask.taskId);
      if (['completed', 'failed', 'needs_reconciliation', 'cancelled'].includes(report.skillTask.state)) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    const skillResource = skillTask && runtime.store.get('SELECT worktree_path FROM task_resources WHERE task_id=?', skillTask.taskId);
    report.skillFile = skillResource && readFileSync(join(skillResource.worktree_path, 'skill-proof.txt'), 'utf8').trim();
    report.skillInvoked = Boolean(runtime.store.get("SELECT event_id FROM conversation_events WHERE type='task.skill_invoked' AND json_extract(payload_json,'$.task_id')=?", skillTask.taskId));
    await send('Report the skill task result.');
    await send('Please verify the isolated worker skill invocation with argument 466 and return the proof file. Use the installed skill that matches this request.');
    const implicitRow = runtime.store.get("SELECT snapshot_json FROM tasks WHERE json_extract(snapshot_json,'$.skill.args')='466'");
    if (!implicitRow) throw new Error('Natural-language request did not dispatch an installed skill');
    const implicitId = JSON.parse(implicitRow.snapshot_json).taskId;
    const implicitDeadline = Date.now() + 100000;
    while (Date.now() < implicitDeadline) {
      report.implicitSkillTask = runtime.store.task(implicitId);
      if (['completed', 'failed', 'needs_reconciliation', 'cancelled'].includes(report.implicitSkillTask.state)) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    const implicitResource = runtime.store.get('SELECT worktree_path FROM task_resources WHERE task_id=?', implicitId);
    report.implicitSkillFile = implicitResource && readFileSync(join(implicitResource.worktree_path, 'skill-proof.txt'), 'utf8').trim();
    report.implicitSkillInvoked = Boolean(runtime.store.get("SELECT event_id FROM conversation_events WHERE type='task.skill_invoked' AND json_extract(payload_json,'$.task_id')=?", implicitId));
    const spoken = [];
    const voice = runtime.submitInput({ scope, text: 'Explain the completed sum fix and the skill test in detail on screen: include code before and after and test evidence. In speech, briefly summarize the outcome in Thai. Do not rerun tasks.', modality: 'live_voice', ingressKey: 'voice-proof' }, { execute: false, writeMemory: false });
    const consume = (async () => { for await (const chunk of voice.stream) spoken.push(chunk.text); })();
    const display = await voice.response; await consume;
    report.voiceSurfaces = { display, spoken: spoken.join('') };
    report.pass = report.implicitSkillTask?.state === 'completed' && report.implicitSkillFile === 'SKILL_EXECUTED_466' && report.implicitSkillInvoked && display.length > spoken.join('').length && spoken.join('').length > 0 && spoken.join('').length <= 600 && report.skillTask?.state === 'completed' && report.skillFile === 'SKILL_EXECUTED_465' && report.skillInvoked && report.task?.state === 'completed' && report.afterDispatch.length === 1 && report.afterDispatch[0].state !== 'completed' && report.sourceProjectUnchanged && report.independentTestOutput === 'sum test passed' && Boolean(report.diff);
  } catch (error) { report.error = { message: error.message, code: error.code }; }
  finally { await runtime?.close(); writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
  process.exit(report.pass ? 0 : 1);
})().catch(error => { console.error(error.message); process.exit(1); });
