/**
 * Isolated memory mode (#601) on the orchestration path: a worker acting
 * for one conversation sees that conversation's memory only, its MCP process has the
 * memory_search/memory_get module off, and scoped memory writes land in the
 * conversation's chats/ directory.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { request } from 'http';
import { SessionProcess } from '../../../src/session/process';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { TaskBridge } from '../../../src/orchestration/bridge';
import { TaskFiles } from '../../../src/orchestration/task-files';
import { TaskWorkspaces } from '../../../src/orchestration/tasks/workspace';
import { ClaudeWorkerDriver } from '../../../src/orchestration/tasks/driver';
import { chatMemoryDir, chatMemoryDirName } from '../../../src/agent/workspace-loader';
import { IDENTITY_EDIT_RULES, SHARED_PERSONA_RULES } from '../../../src/orchestration/source-policy';
import { AgentConfig, GatewayConfig } from '../../../src/types';

let root: string, workspace: string, store: OrchestrationStore, tasks: TaskService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orch-iso-'));
  workspace = join(root, 'agent', 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'CLAUDE.md'), 'SHARED-CONTEXT');
  writeFileSync(join(workspace, 'MEMORY.md'), 'ROOT-MEMORY');
  for (const [chat, memory] of [['111', 'CHAT-A-MEMORY'], ['222', 'CHAT-B-MEMORY']]) {
    mkdirSync(chatMemoryDir(workspace, 'telegram', chat), { recursive: true });
    writeFileSync(join(chatMemoryDir(workspace, 'telegram', chat), 'MEMORY.md'), memory);
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
  async function workerStart(chatId: string, isolateMemory: boolean): Promise<{ context: string; overlay: string; prompt: string; mcpEnv: Record<string, string> }> {
    const agent = { id: 'agent', workspace, description: 'fixture', env: '', claude: { model: 'fixture', extraFlags: [] },
      ...(isolateMemory ? { isolateMemory: true } : {}),
      orchestration: { tasks: { idleTimeoutMs: 30, maxDurationMs: 80 }, conversation: { startupTimeoutMs: 1000, firstResponseTimeoutMs: 1000 } } } as AgentConfig;
    const gateway = { gateway: { headless: true, timezone: 'UTC', logDir: join(root, 'logs') }, agents: [agent] } as GatewayConfig;
    const bridge = new TaskBridge(tasks);
    bridge.isolateMemory = () => isolateMemory;
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

  it("carry only their own conversation's memory", async () => {
    const a = await workerStart('111', true);
    expect(a.context).toContain('SHARED-CONTEXT');
    expect(a.context).toContain('CHAT-A-MEMORY');
    expect(a.context).not.toContain('CHAT-B');
    expect(a.mcpEnv.GATEWAY_ISOLATE_MEMORY).toBe('1');
    const b = await workerStart('222', true);
    expect(b.context).toContain('CHAT-B-MEMORY');
    expect(b.context).not.toContain('CHAT-A');
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
    expect(worker.mcpEnv.GATEWAY_ISOLATE_MEMORY).toBe('');
    expect(worker.overlay).toContain(IDENTITY_EDIT_RULES);
    expect(worker.prompt).toContain('Authorized persona workspace');
  });
});

describe('Agent overlay', () => {
  it('names no persona workspace for the Agent to edit', async () => {
    const overlay = async (isolateMemory: boolean) => {
      const bridge = new TaskBridge(tasks);
      bridge.isolateMemory = () => isolateMemory;
      await bridge.start();
      try {
        const input = store.acceptInput({ scope: { agentId: 'agent', agentSessionId: `o-${isolateMemory}`, source: 'telegram', accountId: 'bot', principalId: 'u', chatId: '111', threadKey: '' }, text: 'Hi' });
        const ticket = bridge.issue({ role: 'agent', context: { conversationId: input.conversationId, principalId: 'u', inputId: input.inputId, decisionId: 'd', epoch: 0, execute: true, writeMemory: true } }, join(root, `agent-${isolateMemory}`), workspace, '');
        return ticket.profile.overlay;
      } finally { await bridge.close(); }
    };
    const isolated = await overlay(true);
    expect(isolated).toContain(SHARED_PERSONA_RULES);
    expect(isolated).not.toContain('This agent persona workspace');
    expect(await overlay(false)).toContain('This agent persona workspace');
  });
});

describe('cron tools', () => {
  it("are refused at the bridge, not only hidden from the worker's tool list", async () => {
    const call = async (isolateMemory: boolean) => {
      const cronCall = jest.fn(async () => ({ jobs: [] }));
      const bridge = new TaskBridge(tasks, new TaskFiles(store, root, undefined, workspace), undefined, undefined, undefined, cronCall);
      bridge.isolateMemory = () => isolateMemory;
      await bridge.start();
      try {
        const { attempt } = spawnTask(`cron-${isolateMemory}`);
        bridge.issue({ role: 'worker', attemptId: attempt.attemptId, generation: attempt.generation }, join(root, `cron-ticket-${isolateMemory}`), workspace);
        const auth = JSON.parse(readFileSync(join(root, `cron-ticket-${isolateMemory}`, 'ticket.json'), 'utf8'));
        // The same request a worker could make with curl and its ticket, bypassing the MCP tool list.
        const body = await new Promise<unknown>((resolve, reject) => {
          const req = request(auth.url, { method: 'POST', headers: { Authorization: `Bearer ${auth.token}` } }, res => {
            let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve(JSON.parse(text)));
          });
          req.on('error', reject); req.end(JSON.stringify({ tool: 'cron_list', args: {}, action_id: 'cron' }));
        });
        const env = JSON.parse(readFileSync(join(root, `cron-ticket-${isolateMemory}`, 'mcp.json'), 'utf8')).mcpServers.gateway.env;
        return { body, called: cronCall.mock.calls.length, advertised: env.GATEWAY_ORCHESTRATION_CRON };
      } finally { await bridge.close(); }
    };
    expect(await call(true)).toEqual({ body: { error: 'TOOL_DENIED' }, called: 0, advertised: '' });
    expect(await call(false)).toEqual({ body: { jobs: [] }, called: 1, advertised: 'true' });
  });
});

describe('task_memory_append', () => {
  it("writes to the conversation's own files, never the shared root", () => {
    const files = new TaskFiles(store, root, undefined, workspace);
    files.isolateMemory = () => true;
    const { task, attempt } = spawnTask('111', true);
    tasks.started(attempt.attemptId, attempt.generation);
    const result = files.remember(attempt.attemptId, attempt.generation, 'remember', { path: 'MEMORY.md', note: 'Likes jasmine tea.' });
    expect(result).toEqual({ updated: true, path: join('chats', chatMemoryDirName('telegram', '111'), 'MEMORY.md') });
    expect(readFileSync(join(chatMemoryDir(workspace, 'telegram', '111'), 'MEMORY.md'), 'utf8')).toContain('Likes jasmine tea.');
    expect(readFileSync(join(workspace, 'MEMORY.md'), 'utf8')).toBe('ROOT-MEMORY');
    // Without a path the note goes to the conversation's MEMORY.md, the file that is injected.
    files.remember(attempt.attemptId, attempt.generation, 'remember-default', { note: 'Prefers mornings.' });
    expect(readFileSync(join(chatMemoryDir(workspace, 'telegram', '111'), 'MEMORY.md'), 'utf8')).toContain('Prefers mornings.');
    // memory/ notes are never injected or searchable in this mode, so they are refused.
    expect(() => files.remember(attempt.attemptId, attempt.generation, 'remember-log', { path: 'memory/notes.md', note: 'Asked about tea.' })).toThrow('MEMORY_PATH_DENIED');
    expect(existsSync(join(workspace, 'memory', 'notes.md'))).toBe(false);
    expect(task.taskId).toBeTruthy();
  });

  it('writes through an app agent workspace, the gateway-owned symlink into the app directory', () => {
    // upsertAgent links agents/<id>/workspace to the installed app's agent dir.
    const appAgentDir = join(root, 'apps', 'demo', 'agent'); mkdirSync(appAgentDir, { recursive: true });
    const link = join(root, 'agents', 'demo-bot', 'workspace'); mkdirSync(join(root, 'agents', 'demo-bot'), { recursive: true });
    symlinkSync(appAgentDir, link);
    const files = new TaskFiles(store, join(root, 'agents'), join(root, 'container-files'), link);
    files.isolateMemory = () => true;
    const { attempt } = spawnTask('111', true);
    tasks.started(attempt.attemptId, attempt.generation);
    files.remember(attempt.attemptId, attempt.generation, 'remember', { note: 'Family A note.' });
    expect(readFileSync(join(chatMemoryDir(appAgentDir, 'telegram', '111'), 'MEMORY.md'), 'utf8')).toContain('Family A note.');
    expect(existsSync(join(appAgentDir, 'MEMORY.md'))).toBe(false);
  });

  it('refuses a chats/ directory redirected by a symlink', () => {
    const files = new TaskFiles(store, root, undefined, workspace);
    files.isolateMemory = () => true;
    const outside = join(root, 'outside'); mkdirSync(outside);
    rmSync(join(workspace, 'chats'), { recursive: true });
    symlinkSync(outside, join(workspace, 'chats'));
    const { attempt } = spawnTask('111', true);
    tasks.started(attempt.attemptId, attempt.generation);
    expect(() => files.remember(attempt.attemptId, attempt.generation, 'remember', { path: 'MEMORY.md', note: 'x' })).toThrow('MEMORY_PATH_DENIED');
    // The refused write leaves nothing behind outside the workspace.
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses a conversation directory that is a dangling symlink with MEMORY_PATH_DENIED', () => {
    const files = new TaskFiles(store, root, undefined, workspace);
    files.isolateMemory = () => true;
    rmSync(chatMemoryDir(workspace, 'telegram', '111'), { recursive: true });
    symlinkSync(join(root, 'deleted'), chatMemoryDir(workspace, 'telegram', '111'));
    const { attempt } = spawnTask('111', true);
    tasks.started(attempt.attemptId, attempt.generation);
    expect(() => files.remember(attempt.attemptId, attempt.generation, 'remember', { path: 'MEMORY.md', note: 'x' })).toThrow('MEMORY_PATH_DENIED');
  });
});
