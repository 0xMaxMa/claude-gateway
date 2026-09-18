import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { request } from 'http';
import { randomUUID } from 'crypto';
import { TaskBridge, containerTaskTools } from '../../../src/orchestration/bridge';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { DecisionService } from '../../../src/orchestration/decisions';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { AGENT_TASK_TOOLS } from '../../../src/orchestration/agent-tool-schemas';
import { SessionStore } from '../../../src/session/store';
import { HistoryDB } from '../../../src/history/db';
import type { SessionProcess } from '../../../src/session/process';
import type { AgentConfig, GatewayConfig } from '../../../src/types';

/** Everything the gateway hands the MCP server, which is the sole producer of the agent's
 * advertised tool list. mcp/server.ts is a pure function of this env plus the role, so an
 * identical env is an identical tools block — position 0 of Anthropic's cached prefix.
 * The ticket path is this decision's own scratch file and never reaches the provider. */
function declaredInventory(mcpConfigPath: string, mask: string[]): string {
  const config = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
  const env = { ...config.mcpServers.gateway.env, GATEWAY_ORCHESTRATION_TICKET_FILE: '<decision-scoped ticket>' };
  let serialized = JSON.stringify({ args: config.mcpServers.gateway.args, env });
  for (const path of mask) serialized = serialized.split(path).join('<local path>');
  return serialized;
}

function hostFixture() {
  const root = mkdtempSync(join(tmpdir(), 'intake-invariant-')), workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const store = new OrchestrationStore(join(root, 'db'), 'a'), tasks = new TaskService(store), decisions = new DecisionService(store);
  const scope = { agentId: 'a', agentSessionId: 'session', source: 'api' as const, accountId: 'u', chatId: 'c', threadKey: '', principalId: 'u' };
  const input = store.acceptInput({ scope, text: 'Review the report' });
  const decision = decisions.begin(input.conversationId, 'u', [input.inputId]);
  const context = { ...input, ...decision, principalId: 'u', execute: true, writeMemory: false };
  return { root, workspace, store, tasks, context, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('the agent tool declaration is identical whether or not semantic intake is enabled', async () => {
  const fixture = hostFixture();
  const bridge = new TaskBridge(fixture.tasks);
  try {
    await bridge.start();
    // The only difference between the two scopes is the feature itself: onIntake is present
    // exactly when runtime.ts computes `semantic` true, and absent on every notification turn
    // and whenever conversation.semanticIntake is off.
    const issue = (name: string, semantic: boolean) => {
      const directory = join(fixture.root, name);
      const ticket = bridge.issue({
        role: 'agent', context: fixture.context, capabilities: async () => ({}),
        ...(semantic ? { onIntake: async () => ({ acknowledged: true }) } : {}),
      }, directory, fixture.workspace);
      return { directory, ...ticket };
    };
    const on = issue('semantic-on', true), off = issue('semantic-off', false);
    expect(declaredInventory(off.profile.mcpConfigPath, [off.directory]))
      .toBe(declaredInventory(on.profile.mcpConfigPath, [on.directory]));
    // The profile itself renders into the CLI argv, so it must not carry the flag either.
    const comparable = (profile: Record<string, unknown>, directory: string) =>
      JSON.stringify({ ...profile, mcpConfigPath: '<decision-scoped mcp.json>' }).split(directory).join('<local path>');
    expect(comparable(off.profile as unknown as Record<string, unknown>, off.directory))
      .toBe(comparable(on.profile as unknown as Record<string, unknown>, on.directory));
    // And the declaration is genuinely present, rather than identical because it is gone.
    expect(AGENT_TASK_TOOLS.map(tool => tool.name)).toContain('conversation_intake');
  } finally { await bridge.close(); fixture.close(); }
});

test('a container agent ticket declares the same tools whether or not semantic intake is enabled', async () => {
  const fixture = hostFixture();
  const bridge = new TaskBridge(fixture.tasks, undefined, undefined, undefined,
    { agent: { id: 'a', workspace: fixture.workspace } as AgentConfig, spool: join(fixture.root, 'spool') });
  try {
    await bridge.start();
    const tools = (name: string, semantic: boolean) => {
      const directory = join(fixture.root, name);
      bridge.issue({
        role: 'agent', context: fixture.context, capabilities: async () => ({}),
        ...(semantic ? { onIntake: async () => ({ acknowledged: true }) } : {}),
      }, directory, fixture.workspace);
      return JSON.parse(readFileSync(join(directory, 'ticket.json'), 'utf8')).tools;
    };
    const on = tools('container-on', true), off = tools('container-off', false);
    expect(JSON.stringify(off)).toBe(JSON.stringify(on));
    expect(off.map((tool: { name: string }) => tool.name)).toContain('conversation_intake');
    expect(containerTaskTools('agent').map(tool => tool.name)).toContain('conversation_intake');
  } finally { await bridge.close(); fixture.close(); }
});

test('conversation_intake refuses explicitly instead of failing when the feature is off', async () => {
  const fixture = hostFixture();
  const bridge = new TaskBridge(fixture.tasks);
  try {
    await bridge.start();
    const ticket = bridge.issue({ role: 'agent', context: fixture.context, capabilities: async () => ({}) },
      join(fixture.root, 'refusal'), fixture.workspace);
    const auth = JSON.parse(readFileSync(join(fixture.root, 'refusal', 'ticket.json'), 'utf8'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const reply = await new Promise<any>((resolve, reject) => {
      const call = request(auth.url, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token } }, response => {
        let body = ''; response.on('data', chunk => body += chunk);
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
      });
      call.on('error', reject);
      call.end(JSON.stringify({ tool: 'conversation_intake', args: { mode: 'ready', acknowledgement: 'On it.' }, action_id: 'intake' }));
    });
    // A declared tool the model may always call must answer it: no error result the model has
    // to guess at, no unhandled exception, and never a silent success that implies the user
    // was acknowledged. The refusal is actionable and it is recorded.
    expect(reply.status).toBe(200);
    expect(reply.body.error).toBeUndefined();
    expect(reply.body.intake_required).toBe(false);
    expect(typeof reply.body.instruction).toBe('string');
    expect(reply.body.instruction.length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain('conversation_intake');
    warn.mockRestore();
    ticket.revoke();
  } finally { await bridge.close(); fixture.close(); }
});

test('an agent session declares the same tools with conversation.semanticIntake on and off', async () => {
  const run = async (semanticIntake: boolean) => {
    const root = mkdtempSync(join(tmpdir(), 'intake-session-')), dir = join(root, 'a'), workspace = join(dir, 'workspace');
    mkdirSync(workspace, { recursive: true }); writeFileSync(join(workspace, 'CLAUDE.md'), 'Identity');
    const agent = { id: 'a', description: 'fixture', env: '', workspace, claude: { model: 'fixture', extraFlags: [] },
      orchestration: { enabled: true, channels: ['api'], conversation: { semanticIntake, intakeWaitMs: 60000 } } } as unknown as AgentConfig;
    const gateway = { gateway: { orchestration: true, headless: true }, agents: [agent] } as GatewayConfig;
    const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a'), sid = randomUUID();
    await sessions.ensureApiSession('a', 'chat', sid);
    let inventory = '';
    const runtime = await AgentOrchestrationRuntime.open(agent, gateway, dir, sessions, history, {
      createAgentSession: async (_id, profile) => Object.assign(new EventEmitter(), {
        runtimeProfile: profile, start: async () => {}, stop: async () => {},
        sendMessage: function (this: EventEmitter) {
          inventory = declaredInventory(profile.mcpConfigPath, [root]);
          this.emit('output', JSON.stringify({ type: 'system', subtype: 'init', tools: ['StructuredOutput'] }));
          this.emit('output', JSON.stringify({ type: 'result', result: JSON.stringify({ display_text: 'Checked.' }) }));
        },
      }) as unknown as SessionProcess,
      releaseAgentSession: async () => {},
    });
    const scope = { agentId: 'a', agentSessionId: sid, source: 'api' as const, accountId: 'owner', chatId: 'chat', threadKey: '', principalId: 'owner' };
    const text = await runtime.send({ scope, text: 'Hello' }, { execute: false, writeMemory: false }, { timeoutMs: 3000 });
    await runtime.close(); (history as any).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true });
    return { inventory, text };
  };
  const on = await run(true), off = await run(false);
  expect(on.inventory).not.toBe('');
  expect(off.inventory).toBe(on.inventory);
  // The flag still has no effect on what an ordinary turn shows the user.
  expect(off.text).toBe('Checked.');
  expect(on.text).toBe('Checked.');
});
