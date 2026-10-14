import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TaskBridge } from '../../../src/orchestration/bridge';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { DecisionService } from '../../../src/orchestration/decisions';
import { parseSkill } from '../../../src/skills/parser';
import type { SkillRegistry } from '../../../src/skills/loader';

// Session a3a24184: a pstack skill task's 25 KB SKILL.md came back in every task_update
// result, and each one stayed in the decision agent's context for the rest of the session.
const BODY = 'PLAYBOOK-BODY-MARKER ' + 'x'.repeat(25_000);
const registry: SkillRegistry = { skills: new Map([['poteto', parseSkill(`---\nname: poteto\ndescription: Playbook\n---\n${BODY}`, { filePath: '/fixture/skills/poteto/SKILL.md', source: 'workspace' })!]]) };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'skill-projection-')), workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const store = new OrchestrationStore(join(root, 'db'), 'a'), tasks = new TaskService(store), decisions = new DecisionService(store);
  const scope = { agentId: 'a', agentSessionId: 'session', source: 'api' as const, accountId: 'u', chatId: 'c', threadKey: '', principalId: 'u' };
  const input = store.acceptInput({ scope, text: '/poteto #591' });
  const decision = decisions.begin(input.conversationId, 'u', [input.inputId]);
  const context = { ...input, ...decision, principalId: 'u', execute: true, writeMemory: false };
  const bridge = new TaskBridge(tasks, undefined, undefined, () => registry);
  const call = async (name: string, tool: string, action_id: string, args: Record<string, unknown>) => {
    const auth = JSON.parse(readFileSync(join(root, name, 'ticket.json'), 'utf8'));
    const reply = await fetch(auth.url, { method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool, action_id, args }) });
    const text = await reply.text();
    expect(reply.status).toBe(200);
    return { text, body: JSON.parse(text) };
  };
  return { root, workspace, store, tasks, context, bridge, call, close: async () => { await bridge.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

/** What every agent- or client-facing copy of a skill task must look like. Violations are
 * collected per path so a failure names every leaking path, not just the first. */
const violations: string[] = [];
function expectProjected(path: string, text: string, body: any) {
  if (text.includes('PLAYBOOK-BODY-MARKER')) violations.push(`${path}: skill body (${text.length} bytes)`);
  if (text.includes('/fixture/skills/poteto')) violations.push(`${path}: skill file path`);
  if (JSON.stringify(body?.skill) !== JSON.stringify({ name: 'poteto', args: '#591' })) violations.push(`${path}: skill name/args missing`);
}

test('task tool results carry the skill name and args, never its body or host path', async () => {
  const f = fixture();
  try {
    await f.bridge.start();
    f.bridge.issue({ role: 'agent', context: f.context }, join(f.root, 'agent'), f.workspace);
    const spawnArgs = { title: 'Run poteto', instructions: 'Run the playbook', target_profile: 'skill-worker', skill_name: 'poteto', skill_args: '#591' };
    const spawned = await f.call('agent', 'task_spawn', 'spawn', spawnArgs);
    expectProjected('task_spawn', spawned.text, spawned.body);
    // A replayed receipt is read back from task_commands, which kept the whole snapshot.
    const replayed = await f.call('agent', 'task_spawn', 'spawn', spawnArgs);
    expectProjected('task_spawn replay', replayed.text, replayed.body);
    const taskId = spawned.body.taskId;
    // The worker still runs the real body.
    expect(f.store.task(taskId)!.skill!.content).toContain('PLAYBOOK-BODY-MARKER');

    const updated = await f.call('agent', 'task_update', 'update', { task_id: taskId, expected_revision: 1, instruction: 'Also check CI', mode: 'when_ready' });
    expectProjected('task_update', updated.text, updated.body);
    const shown = await f.call('agent', 'task_status', 'status', { task_id: taskId });
    expectProjected('task_status', shown.text, shown.body[0]);
    const listed = await f.call('agent', 'task_status', 'list', {});
    if (listed.text.includes('PLAYBOOK-BODY-MARKER')) violations.push('task_status list: skill body');

    // The worker asks a question through its own bridge scope; the agent answers it.
    const attempt = f.tasks.claim(taskId)!;
    f.tasks.started(attempt.attemptId, attempt.generation);
    f.bridge.issue({ role: 'worker', attemptId: attempt.attemptId, generation: attempt.generation }, join(f.root, 'worker'), f.workspace);
    const asked = await f.call('worker', 'task_request_input', 'ask', { question: 'Which branch?' });
    expectProjected('task_request_input', asked.text, asked.body);
    const answered = await f.call('agent', 'task_answer', 'answer', { task_id: taskId, question_id: asked.body.pendingQuestion.questionId, answer: 'feat/584' });
    expectProjected('task_answer', answered.text, answered.body);
    const cancelled = await f.call('agent', 'task_cancel', 'cancel', { task_id: taskId });
    expectProjected('task_cancel', cancelled.text, cancelled.body);

    // State events feed the activity API and are stored once per state change.
    const events = f.store.all("SELECT payload_json FROM conversation_events WHERE type='task.state_changed'");
    expect(events.length).toBeGreaterThan(3);
    events.forEach((event, i) => expectProjected(`task.state_changed event ${i}`, String(event.payload_json), JSON.parse(String(event.payload_json)).payload));
    expect(violations).toEqual([]);
  } finally { await f.close(); }
});
