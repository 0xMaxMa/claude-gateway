/**
 * Multi-tenant isolate mode (#601) on the orchestration path: a worker acting
 * for one conversation sees that tenant's memory only, its MCP process has the
 * memory_search/memory_get module off, and scoped memory writes land in the
 * conversation's tenants/ directory.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionProcess } from '../../../src/session/process';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { TaskBridge } from '../../../src/orchestration/bridge';
import { TaskFiles } from '../../../src/orchestration/task-files';
import { TaskWorkspaces } from '../../../src/orchestration/tasks/workspace';
import { ClaudeWorkerDriver } from '../../../src/orchestration/tasks/driver';
import { tenantDir, tenantDirName } from '../../../src/agent/workspace-loader';
import { IDENTITY_EDIT_RULES, SHARED_PERSONA_RULES } from '../../../src/orchestration/source-policy';
import { AgentConfig, GatewayConfig } from '../../../src/types';

let root: string, workspace: string, store: OrchestrationStore, tasks: TaskService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orch-mt-'));
  workspace = join(root, 'agent', 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'CLAUDE.md'), 'SHARED-CONTEXT');
  writeFileSync(join(workspace, 'MEMORY.md'), 'ROOT-MEMORY');
  for (const [chat, memory] of [['111', 'TENANT-A-MEMORY'], ['222', 'TENANT-B-MEMORY']]) {
    mkdirSync(tenantDir(workspace, 'telegram', chat), { recursive: true });
    writeFileSync(join(tenantDir(workspace, 'telegram', chat), 'MEMORY.md'), memory);
  }
  store = new OrchestrationStore(':memory:', 'agent');
  tasks = new TaskService(store);
});

afterEach(() => { jest.restoreAllMocks(); store.close(); rmSync(root, { recursive: true, force: true }); });

function spawnTask(chatId: string, writeMemory = false) {
  const input = store.acceptInput({ scope: { agentId: 'agent', agentSessionId: `s-${chatId}`, source: 'telegram', accountId: 'bot', principalId: 'u', chatId, threadKey: '' }, text: 'Work' });
  const decision = new DecisionService(store).begin(input.conversationId, 'u', [input.inputId]);
  const task = tasks.spawn({ ...input, ...decision, principalId: 'u', actionId: `spawn-${chatId}`, execute: true, writeMemory }, { title: 'Work', instructions: 'Work', targetProfile: 'media-worker' });
  return { task, attempt: tasks.claim(task.taskId)! };
}

describe('workers', () => {
  async function workerStart(chatId: string, multiTenant: boolean): Promise<{ context: string; overlay: string; prompt: string; mcpEnv: Record<string, string> }> {
    const agent = { id: 'agent', workspace, description: 'fixture', env: '', claude: { model: 'fixture', extraFlags: [] },
      ...(multiTenant ? { multiTenant: { enabled: true } } : {}),
      orchestration: { tasks: { idleTimeoutMs: 30, maxDurationMs: 80 }, conversation: { startupTimeoutMs: 1000, firstResponseTimeoutMs: 1000 } } } as AgentConfig;
    const gateway = { gateway: { headless: true, timezone: 'UTC', logDir: join(root, 'logs') }, agents: [agent] } as GatewayConfig;
    const bridge = new TaskBridge(tasks);
    bridge.multiTenant = () => multiTenant;
    let seen: { context: string; overlay: string; prompt: string; mcpEnv: Record<string, string> } | undefined;
    jest.spyOn(SessionProcess.prototype, 'start').mockImplementation(async function (this: SessionProcess) {
      const profile = this.runtimeProfile!;
      seen = { context: profile.context!, overlay: profile.overlay, prompt: '', mcpEnv: JSON.parse(readFileSync(profile.mcpConfigPath, 'utf8')).mcpServers.gateway.env };
    });
    jest.spyOn(SessionProcess.prototype, 'sendMessage').mockImplementation((text: string) => { seen!.prompt += text; });
    jest.spyOn(SessionProcess.prototype, 'stop').mockImplementation(async function (this: SessionProcess) { this.managedGroupStopped = true; });
    try {
      await bridge.start();
      const { task, attempt } = spawnTask(chatId);
      const driver = new ClaudeWorkerDriver(agent, gateway, tasks, bridge, new TaskWorkspaces(store, workspace, join(root, 'resources')), join(root, 'private'));
      const handle = await driver.start(store.task(task.taskId)!, attempt, true);
      // The mocked worker never answers; its timeout is not what this test checks.
      await handle.accepted.catch(() => {}); await handle.result.catch(() => {});
    } finally { await bridge.close(); }
    return seen!;
  }

  it("carry only their own conversation's tenant memory", async () => {
    const a = await workerStart('111', true);
    expect(a.context).toContain('SHARED-CONTEXT');
    expect(a.context).toContain('TENANT-A-MEMORY');
    expect(a.context).not.toContain('TENANT-B');
    expect(a.mcpEnv.GATEWAY_MULTI_TENANT_ISOLATE).toBe('1');
    const b = await workerStart('222', true);
    expect(b.context).toContain('TENANT-B-MEMORY');
    expect(b.context).not.toContain('TENANT-A');
  });

  it('are given no authority to change the persona every conversation shares', async () => {
    const worker = await workerStart('111', true);
    expect(worker.overlay).toContain(SHARED_PERSONA_RULES);
    expect(worker.overlay).not.toContain(IDENTITY_EDIT_RULES);
    expect(worker.prompt).toContain(SHARED_PERSONA_RULES);
    expect(worker.prompt).not.toContain('Authorized persona workspace');
  });

  it('are unchanged when isolate mode is off', async () => {
    const worker = await workerStart('111', false);
    expect(worker.context).toBe('SHARED-CONTEXT');
    expect(worker.mcpEnv.GATEWAY_MULTI_TENANT_ISOLATE).toBe('');
    expect(worker.overlay).toContain(IDENTITY_EDIT_RULES);
    expect(worker.prompt).toContain('Authorized persona workspace');
  });
});

describe('Agent overlay', () => {
  it('names no persona workspace for the Agent to edit', async () => {
    const overlay = async (multiTenant: boolean) => {
      const bridge = new TaskBridge(tasks);
      bridge.multiTenant = () => multiTenant;
      await bridge.start();
      try {
        const input = store.acceptInput({ scope: { agentId: 'agent', agentSessionId: `o-${multiTenant}`, source: 'telegram', accountId: 'bot', principalId: 'u', chatId: '111', threadKey: '' }, text: 'Hi' });
        const ticket = bridge.issue({ role: 'agent', context: { conversationId: input.conversationId, principalId: 'u', inputId: input.inputId, decisionId: 'd', epoch: 0, execute: true, writeMemory: true } }, join(root, `agent-${multiTenant}`), workspace, '');
        return ticket.profile.overlay;
      } finally { await bridge.close(); }
    };
    const isolated = await overlay(true);
    expect(isolated).toContain(SHARED_PERSONA_RULES);
    expect(isolated).not.toContain('This agent persona workspace');
    expect(await overlay(false)).toContain('This agent persona workspace');
  });
});

describe('task_memory_append', () => {
  it("writes to the conversation's tenant files, never the shared root", () => {
    const files = new TaskFiles(store, root, undefined, workspace);
    files.multiTenant = () => true;
    const { task, attempt } = spawnTask('111', true);
    tasks.started(attempt.attemptId, attempt.generation);
    const result = files.remember(attempt.attemptId, attempt.generation, 'remember', { path: 'MEMORY.md', note: 'Likes jasmine tea.' });
    expect(result).toEqual({ updated: true, path: join('tenants', tenantDirName('telegram', '111'), 'MEMORY.md') });
    expect(readFileSync(join(tenantDir(workspace, 'telegram', '111'), 'MEMORY.md'), 'utf8')).toContain('Likes jasmine tea.');
    expect(readFileSync(join(workspace, 'MEMORY.md'), 'utf8')).toBe('ROOT-MEMORY');
    // Without a path the note goes to the tenant MEMORY.md, the file that is injected.
    files.remember(attempt.attemptId, attempt.generation, 'remember-default', { note: 'Prefers mornings.' });
    expect(readFileSync(join(tenantDir(workspace, 'telegram', '111'), 'MEMORY.md'), 'utf8')).toContain('Prefers mornings.');
    // memory/ notes are never injected or searchable in this mode, so they are refused.
    expect(() => files.remember(attempt.attemptId, attempt.generation, 'remember-log', { path: 'memory/notes.md', note: 'Asked about tea.' })).toThrow('MEMORY_PATH_DENIED');
    expect(existsSync(join(workspace, 'memory', 'notes.md'))).toBe(false);
    expect(task.taskId).toBeTruthy();
  });

  it('refuses a tenants/ directory redirected by a symlink', () => {
    const files = new TaskFiles(store, root, undefined, workspace);
    files.multiTenant = () => true;
    const outside = join(root, 'outside'); mkdirSync(outside);
    rmSync(join(workspace, 'tenants'), { recursive: true });
    symlinkSync(outside, join(workspace, 'tenants'));
    const { attempt } = spawnTask('111', true);
    tasks.started(attempt.attemptId, attempt.generation);
    expect(() => files.remember(attempt.attemptId, attempt.generation, 'remember', { path: 'MEMORY.md', note: 'x' })).toThrow('MEMORY_PATH_DENIED');
    // The refused write leaves nothing behind outside the workspace.
    expect(readdirSync(outside)).toEqual([]);
  });
});
