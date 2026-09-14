/**
 * Tests for executeApiCommand /session and /sessions message counting (#160).
 *
 * api session context lives in the flat sessions/{sessionId}.jsonl store, but the
 * structured index's messageCount is never maintained on the api append path. Before
 * the fix /session and /sessions reported `0` messages. These drive executeApiCommand
 * directly and assert the counts come from the flat store (via loadSession).
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── Mock child_process (restartProcess on /clear spawns a child; SessionCompactor's
//    async `claude --print` spawn (#376) also goes through this same `spawn` mock —
//    distinguished by the `--print` flag, since compactor calls no longer use spawnSync) ──

interface MockChildProcess extends EventEmitter {
  stdin: { writable: boolean; write: jest.Mock; end: jest.Mock; on: jest.Mock } | null;
  stdout: EventEmitter | null;
  stderr: EventEmitter | null;
  killed: boolean;
  kill: jest.Mock;
  pid: number;
}

function makeMockProcess(): MockChildProcess {
  const proc = new EventEmitter() as MockChildProcess;
  proc.stdin = { writable: true, write: jest.fn(), end: jest.fn(), on: jest.fn() };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.pid = Math.floor(Math.random() * 90000) + 10000;
  proc.kill = jest.fn((signal?: string) => {
    proc.killed = true;
    process.nextTick(() => proc.emit('exit', 0, signal ?? 'SIGTERM'));
    return true;
  });
  return proc;
}

/** Queued result for the compactor's `claude --print` spawn — set via mockCompactorCli.mockReturnValueOnce(...). */
const mockCompactorCli = jest.fn(() => ({ status: 0, stdout: '', stderr: '', error: undefined as Error | undefined }));

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: jest.fn((_bin: string, args: string[]) => {
    const proc = makeMockProcess();
    if (args.includes('--print')) {
      // SessionCompactor's defaultSpawnClaude: resolve async (next tick, like a real
      // child exiting) via the queued result instead of the old sync spawnSync return.
      const r = mockCompactorCli();
      process.nextTick(() => {
        if (r.error) {
          proc.emit('error', r.error);
          return;
        }
        if (r.stdout) proc.stdout!.emit('data', r.stdout);
        if (r.stderr) proc.stderr!.emit('data', r.stderr);
        proc.emit('close', r.status);
      });
    }
    return proc;
  }),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { AgentRunner } from '../../src/agent/runner';
import { AgentConfig, GatewayConfig, Message } from '../../src/types';
import { SessionStore } from '../../src/session/store';
import { OrchestrationStore } from '../../src/orchestration/store';
import { TaskService } from '../../src/orchestration/tasks/service';
import { DecisionService } from '../../src/orchestration/decisions';
import { StopControls } from '../../src/orchestration/stop-controls';

// ── Helpers ─────────────────────────────────────────────────────────────────────

function makeAgentConfig(workspace: string): AgentConfig {
  return {
    id: 'alfred',
    description: 'test agent',
    workspace,
    env: '',
    telegram: { botToken: 'test-token' },
    claude: { model: 'claude-opus-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
  };
}

function makeGatewayConfig(): GatewayConfig {
  return { gateway: { logDir: '/tmp/test-api-cmd-logs', timezone: 'UTC' }, agents: [] };
}

function getSessionStore(runner: AgentRunner): SessionStore {
  return (runner as unknown as { sessionStore: SessionStore }).sessionStore;
}

function makeMsg(role: 'user' | 'assistant', content: string): Message {
  return { role, content, ts: Date.now() };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('executeApiCommand session counting (#160)', () => {
  let tmpDir: string;
  let runner: AgentRunner;
  const agentId = 'alfred';
  const chatId = 'web-1';        // executeApiCommand uses chatId as the store chatId
  const sessionId = 'sess-1';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-cmd-test-'));
    const workspaceDir = path.join(tmpDir, 'agents', 'alfred', 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'config.json'),
      JSON.stringify({ agents: [{ id: 'alfred', claude: { model: 'claude-opus-4-6' } }] }, null, 2) + '\n',
    );
    runner = new AgentRunner(makeAgentConfig(workspaceDir), makeGatewayConfig());
    mockCompactorCli.mockReset();
    mockCompactorCli.mockReturnValue({ status: 0, stdout: '', stderr: '', error: undefined });
  });

  afterEach(async () => {
    if (runner) await runner.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Seed the flat store the same way the api message path does (keyed by sessionId).
  async function seedFlatStore(sid: string, count: number): Promise<void> {
    const store = getSessionStore(runner);
    for (let i = 0; i < count; i++) {
      await store.appendMessage(agentId, sid, makeMsg(i % 2 === 0 ? 'user' : 'assistant', `m${i}`));
    }
  }

  it('U-RUN-01: /session reports the real flat-store message count, not the stale index 0', async () => {
    await seedFlatStore(sessionId, 5);

    const { result, responseText } = await runner.executeApiCommand(sessionId, chatId, '/session', { skipPersist: true });

    expect(result.messageCount).toBe(5);
    expect(responseText).toContain('Messages: 5');
  });

  it('U-RUN-02: /session reports 0 for an empty session without throwing', async () => {
    const { result, responseText } = await runner.executeApiCommand(sessionId, chatId, '/session', { skipPersist: true });

    expect(result.messageCount).toBe(0);
    expect(responseText).toContain('Messages: 0');
  });

  it('U-RUN-03: /session dispatches on the first token, so trailing args still resolve', async () => {
    await seedFlatStore(sessionId, 3);

    const { result } = await runner.executeApiCommand(sessionId, chatId, '/session please', { skipPersist: true });

    expect(result.messageCount).toBe(3);
  });

  it('U-RUN-04: /sessions lists each session with its real flat-store count and marks current', async () => {
    // Two api sessions, each with a different number of flat-store messages.
    await seedFlatStore(sessionId, 4);
    await seedFlatStore('sess-2', 2);
    // Register both in the api index (as ensureApiSession would on first use).
    await getSessionStore(runner).ensureApiSession(agentId, chatId, sessionId);
    await getSessionStore(runner).ensureApiSession(agentId, chatId, 'sess-2');

    const { result, responseText } = await runner.executeApiCommand(sessionId, chatId, '/sessions', { skipPersist: true });

    const sessions = result.sessions as Array<{ id: string; messageCount: number; current: boolean }>;
    const s1 = sessions.find((s) => s.id === sessionId)!;
    const s2 = sessions.find((s) => s.id === 'sess-2')!;
    expect(s1.messageCount).toBe(4); // from the flat store, not the stale index count
    expect(s2.messageCount).toBe(2);
    expect(s1.current).toBe(true);
    expect(s2.current).toBe(false);
    // Exactly one session is marked current.
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    expect(responseText).toContain('(current)');
  });

  it('U-RUN-05: /compact end-to-end — compacts the flat store and returns keptMessages count', async () => {
    await seedFlatStore(sessionId, 6);
    mockCompactorCli.mockReturnValueOnce({ status: 0, stdout: 'Compact summary.', stderr: '', error: undefined });

    const { result, responseText } = await runner.executeApiCommand(sessionId, chatId, '/compact', { skipPersist: true });

    expect(result.success).toBe(true);
    // afterMessages = 1 summary + 6 verbatim (all < KEEP_LAST_MESSAGES default)
    expect(result.keptMessages).toBe(7);
    expect(responseText).toContain('compacted');
    // The flat store must have been overwritten with the compacted result.
    const flat = await getSessionStore(runner).loadSession(agentId, sessionId);
    expect(flat.length).toBeGreaterThan(0);
    expect(flat[0].role).toBe('system');
    expect((flat[0].content as string)).toContain('[Conversation Summary]');
  });

  it('U-RUN-06: an unknown command throws before persisting anything', async () => {
    await expect(
      runner.executeApiCommand(sessionId, chatId, '/bogus', { skipPersist: true }),
    ).rejects.toThrow('Unknown command: /bogus');
  });

  it('U-RUN-07: /clear empties the flat store the model reloads at spawn', async () => {
    await seedFlatStore(sessionId, 6);
    expect(await getSessionStore(runner).loadSession(agentId, sessionId)).toHaveLength(6);

    const { result } = await runner.executeApiCommand(sessionId, chatId, '/clear', { skipPersist: true });

    expect(result.success).toBe(true);
    expect(await getSessionStore(runner).loadSession(agentId, sessionId)).toEqual([]);
  });
  test('managed /stop persists the numbered prompt and numeric replies cancel only the selected task',async()=>{
    const store=new OrchestrationStore(':memory:',agentId),tasks=new TaskService(store),decisions=new DecisionService(store);
    try{
      const input=store.acceptInput({scope:{agentId,agentSessionId:sessionId,source:'api',accountId:'owner',chatId,threadKey:'',principalId:'owner'},text:'Work'});
      const decision=decisions.begin(input.conversationId,'owner',[input.inputId]);
      const task=tasks.spawn({...input,...decision,principalId:'owner',actionId:'spawn',execute:true,writeMemory:false},{title:'Review PR',instructions:'fixture',targetProfile:'default-worker'});
      const control=new StopControls(store,tasks,()=>false);
      (runner as any).agentConfig.orchestration={enabled:true,channels:['api']};
      (runner as any).orchestration={stopControls:control,authorizeSession:(_s:string,p:string)=>store.assertMember(input.conversationId,p)};
      const menu=await runner.executeApiCommand(sessionId,chatId,'/stop',{skipPersist:true,principalId:'owner'});
      expect(menu.responseText).toContain('1. Review PR');expect(menu.result.responseText).toBe(menu.responseText);
      const command=runner.apiTaskStopReply(sessionId,'owner','1')!;
      const chosen=await runner.executeApiCommand(sessionId,chatId,command,{principalId:'owner',displayCommand:'1'});
      expect(chosen.responseText).toContain('Cancelled task: Review PR');expect(store.task(task.taskId)!.state).toBe('cancelled');
    }finally{(runner as any).orchestration=undefined;store.close();}
  });
  test('disabled orchestration retains legacy stop and ignores numeric stop menus',async()=>{
    const open=jest.fn();(runner as any).orchestration={stopControls:{open,replyCommand:jest.fn()},isBusy:()=>false};
    try{
      (runner as any).agentConfig.orchestration={enabled:false};
      expect(runner.apiTaskStopReply(sessionId,'owner','1')).toBeUndefined();
      const result=await runner.executeApiCommand(sessionId,chatId,'/stop',{principalId:'owner'});
      expect(result.responseText).toBe('No active session to stop.');expect(open).not.toHaveBeenCalled();
    }finally{(runner as any).orchestration=undefined;}
  });

  test('command capability hot reload replaces only the receiver and picks up the latest mode',async()=>{
    const spawn=require('child_process').spawn as jest.Mock;
    const stop=jest.spyOn(runner,'stop');
    runner.startTelegramReceiver();const original=(runner as any).receiver;
    (runner as any).gatewayConfig.gateway.headless=false;runner.refreshTelegramCommands();
    await new Promise(resolve=>setImmediate(resolve));
    expect((runner as any).receiver).not.toBe(original);
    const environment=()=>spawn.mock.calls.filter((c:any[])=>c[1]?.[0]?.endsWith('receiver-server.ts')).at(-1)[2].env;
    expect(environment().GATEWAY_INTERACTIVE_CLI_ENABLED).toBe('true');
    (runner as any).gatewayConfig.gateway.orchestration=true;
    runner.updateAgentConfig({...((runner as any).agentConfig),orchestration:{}});
    await new Promise(resolve=>setImmediate(resolve));
    expect(environment().GATEWAY_ORCHESTRATION_ENABLED).toBe('true');expect(environment().GATEWAY_INTERACTIVE_CLI_ENABLED).toBe('false');
    expect(stop).not.toHaveBeenCalled();
  });

});
