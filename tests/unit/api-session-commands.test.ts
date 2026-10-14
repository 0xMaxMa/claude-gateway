import { createHash } from 'crypto';
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
import { resetModelCatalogCache, resetSettingsEnvCache } from '../../src/agent/model-catalog';
import { AgentConfig, GatewayConfig, Message } from '../../src/types';
import { SessionStore } from '../../src/session/store';
import { OrchestrationStore } from '../../src/orchestration/store';
import { TaskService } from '../../src/orchestration/tasks/service';
import { DecisionService } from '../../src/orchestration/decisions';
import { StopControls } from '../../src/orchestration/stop-controls';
import { ChannelControls } from '../../src/orchestration/channel-controls';
import { TaskControls } from '../../src/orchestration/task-controls';

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
  return { gateway: { orchestration: false, logDir: '/tmp/test-api-cmd-logs', timezone: 'UTC' }, agents: [] };
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

  it('/help executes locally and lists all API commands without inference', async () => {
    const {result,responseText}=await runner.executeApiCommand(sessionId,chatId,'/help',{skipPersist:true});
    expect(result.text).toBe(responseText);
    for(const command of ['/help','/session','/sessions','/clear','/compact','/stop','/restart','/model']) expect(responseText).toContain(command+' —');
    expect(responseText).not.toContain('/voices');
  });

  // Review of #591 (L2): /tasks was listed whenever orchestration was on, also where the web chat is not orchestrated.
  it('/help lists /tasks only when the web chat is in orchestration mode', async () => {
    const config = (runner as unknown as { agentConfig: AgentConfig }).agentConfig;
    config.orchestration = { enabled: true, channels: ['telegram'] } as AgentConfig['orchestration'];
    expect((await runner.executeApiCommand(sessionId, chatId, '/help', { skipPersist: true })).responseText).not.toMatch(/^\/tasks — /m);
    config.orchestration = { enabled: true, channels: ['api'] } as AgentConfig['orchestration'];
    expect((await runner.executeApiCommand(sessionId, chatId, '/help', { skipPersist: true })).responseText).toMatch(/^\/tasks — /m);
    delete config.orchestration;
  });

  // Third review of #591 (L2): /help and /tasks decided "orchestrated" differently, so a session
  // orchestration still owns listed /tasks while /tasks said it needs orchestration mode.
  it('/help and /tasks agree for a session orchestration still owns', async () => {
    const internals = runner as unknown as { agentConfig: AgentConfig; orchestration: unknown };
    const saved = internals.orchestration;
    internals.agentConfig.orchestration = { enabled: true, channels: ['telegram'] } as AgentConfig['orchestration'];
    internals.orchestration = { ownsSession: () => true, canReturnToLegacy: () => false, authorizeSession: () => {},
      channelControls: { handle: async () => ({ text: 'Your tasks', buttons: [] }) } };
    try {
      expect((await runner.executeApiCommand(sessionId, chatId, '/help', { skipPersist: true })).responseText).toMatch(/^\/tasks — /m);
      expect((await runner.executeApiCommand(sessionId, chatId, '/tasks', { skipPersist: true, principalId: 'u' })).responseText).toBe('Your tasks');
    } finally { internals.orchestration = saved; delete internals.agentConfig.orchestration; }
  });

  it('/restart awaits the actual stop instead of reporting success early', async () => {
    let finish!: () => void;
    const restart = jest.spyOn(runner as any, 'restartProcess').mockImplementation(() => new Promise<void>(resolve => {finish=resolve;}));
    let settled = false;
    const response = runner.executeApiCommand(sessionId, chatId, '/restart confirm', {skipPersist:true}).then(result => {settled=true;return result;});
    while (!finish) await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    finish();
    await expect(response).resolves.toMatchObject({result:{restarting:true}});
    expect(restart).toHaveBeenCalledWith(sessionId, sessionId);
    restart.mockRestore();
  });

  it('U-RUN-01: /session reports the real flat-store message count, not the stale index 0', async () => {
    await seedFlatStore(sessionId, 5);

    const { result, responseText } = await runner.executeApiCommand(sessionId, chatId, '/session', { skipPersist: true });

    expect(result.messageCount).toBe(5);
    expect(responseText).not.toContain('Messages:');
    expect(responseText).toContain('Context: —');
  });

  it('U-RUN-02: /session reports 0 for an empty session without throwing', async () => {
    const { result, responseText } = await runner.executeApiCommand(sessionId, chatId, '/session', { skipPersist: true });

    expect(result.messageCount).toBe(0);
    expect(responseText).not.toContain('Messages:');
    expect(responseText).toContain('Context: —');
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

  it('U-RUN-05: /compact invokes native CLI and preserves every flat-store message', async () => {
    await seedFlatStore(sessionId, 60);
    const before = await getSessionStore(runner).loadSession(agentId, sessionId);
    const process = Object.assign(new EventEmitter(), {
      sessionId, isRunning:()=>true, isProcessing:false, start:jest.fn(async()=>{}),
      sendMessage:jest.fn(function(this:EventEmitter,text:string){
        this.emit('output',JSON.stringify({type:'system',subtype:'compact_boundary'}));
        this.emit('output',JSON.stringify({type:'result',result:'Compacted'}));
      }),stop:async()=>{},
    });
    (runner as any).sessions.set(sessionId,process);
    const { result, responseText } = await runner.executeApiCommand(sessionId, chatId, '/compact confirm', { skipPersist: true });
    expect(result).toEqual({success:true,native:true,historyUnchanged:true});
    expect(process.sendMessage).toHaveBeenCalledWith('/compact',[]);
    expect(process.start).not.toHaveBeenCalled();
    expect(responseText).toContain('history is unchanged');
    expect(await getSessionStore(runner).loadSession(agentId, sessionId)).toEqual(before);
  });

  it('U-RUN-06: an unknown command throws before persisting anything', async () => {
    await expect(
      runner.executeApiCommand(sessionId, chatId, '/bogus', { skipPersist: true }),
    ).rejects.toThrow('Unknown command: /bogus');
  });

  it('U-RUN-07: /clear preserves history and requests a durable 50-message bootstrap', async () => {
    await seedFlatStore(sessionId, 6);
    const db = (runner as any).historyDb;
    const clearChat = jest.spyOn(db, 'clearChat');
    const clearSession = jest.spyOn(db, 'clearSession');
    expect(await getSessionStore(runner).loadSession(agentId, sessionId)).toHaveLength(6);

    const { result } = await runner.executeApiCommand(sessionId, chatId, '/clear confirm', { skipPersist: true });

    expect(result.success).toBe(true);
    expect(await getSessionStore(runner).loadSession(agentId, sessionId)).toHaveLength(6);
    expect(getSessionStore(runner).getContextReset(agentId, sessionId)).toMatchObject({historyLimit:50});
    expect(result.historyUnchanged).toBe(true);
    expect(clearChat).not.toHaveBeenCalled();
    expect(clearSession).not.toHaveBeenCalled();
  });
  it('/clear rejects an active managed response without changing history or the next bootstrap', async () => {
    await seedFlatStore(sessionId, 6);
    const reset = jest.fn();
    (runner as any).orchestration = {isBusy:()=>true,ownsSession:()=>true,resetSessionContext:reset};
    try {
      await expect((runner as any).clearContext(sessionId)).rejects.toThrow('responding');
      expect(reset).not.toHaveBeenCalled();
      expect(getSessionStore(runner).getContextReset(agentId,sessionId)).toBeUndefined();
      expect(await getSessionStore(runner).loadSession(agentId,sessionId)).toHaveLength(6);
    } finally {(runner as any).orchestration=undefined;}
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

  // PR #591 dev e2e: on the web these ran at once, while the chat channels ask first.
  describe.each([
    ['/clear', 'Reset Claude Code context?', 'clearContext'],
    ['/compact', 'Compact Claude Code context?', 'compactContext'],
    ['/restart', 'Restart this session process?', 'restartProcess'],
  ])('%s asks for confirmation on the web', (command, prompt, method) => {
    const ask = () => runner.executeApiCommand(sessionId, chatId, command, { skipPersist: true, principalId: 'owner' });
    const press = (action: string, principalId = 'owner') => runner.executeApiCommand(sessionId, chatId, action, { skipPersist: true, principalId });
    let run: jest.SpyInstance;
    beforeEach(() => { run = jest.spyOn(runner as any, method).mockResolvedValue(undefined); });
    afterEach(() => run.mockRestore());

    it('returns the prompt and one-use Yes/No actions without running', async () => {
      const reply = await ask();
      expect(reply.responseText).toContain(prompt);
      expect(reply.responseText).toContain(`${command} confirm`);
      expect(reply.result).toEqual({ confirmationRequired: true });
      expect(reply.actions).toEqual([{ label: 'Yes', command: expect.stringMatching(/^\/orch [0-9a-f-]{36}$/) }, { label: 'No', command: expect.stringMatching(/^\/orch [0-9a-f-]{36}$/) }]);
      expect(run).not.toHaveBeenCalled();
    });

    it('Yes runs it once; a replayed or stale action, or another key, does not', async () => {
      const [yes, no] = (await ask()).actions;
      expect((await press(yes!.command, 'intruder')).result).toEqual({ error: 'CONFIRMATION_UNAVAILABLE' });
      await press(yes!.command);
      expect(run).toHaveBeenCalledTimes(1);
      for (const action of [yes!, no!]) expect((await press(action.command)).responseText).toBe('Confirmation expired or unavailable. Run the command again.');
      expect(run).toHaveBeenCalledTimes(1);

      const stale = (await ask()).actions[0]!;
      const now = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 300_001);
      try { expect((await press(stale.command)).result).toEqual({ error: 'CONFIRMATION_UNAVAILABLE' }); } finally { clock.mockRestore(); }
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('No cancels, and asking again retires the earlier actions', async () => {
      const first = (await ask()).actions;
      const second = (await ask()).actions;
      expect((await press(first[0]!.command)).result).toEqual({ error: 'CONFIRMATION_UNAVAILABLE' });
      expect(await press(second[1]!.command)).toMatchObject({ responseText: 'Cancelled.', result: { cancelled: true }, actions: [] });
      expect(run).not.toHaveBeenCalled();
    });

    it(`${command} confirm runs it directly, for a caller that has already confirmed`, async () => {
      await runner.executeApiCommand(sessionId, chatId, `${command} confirm`, { skipPersist: true });
      expect(run).toHaveBeenCalledTimes(1);
    });
  });

  it('/clear confirm runs the reset', async () => {
    await seedFlatStore(sessionId, 3);
    const { result } = await runner.executeApiCommand(sessionId, chatId, '/clear confirm', { skipPersist: true });
    expect(result.success).toBe(true);
    expect(getSessionStore(runner).getContextReset(agentId, sessionId)).toMatchObject({ historyLimit: 50 });
  });

  // PR #591 dev e2e: these reached the model on the web.
  // Review of #591 (M5): the catalog is isolated from this host's ~/.claude/settings.json and provider env.
  it('/models lists the catalog with the current model and points at the web picker', async () => {
    const keys = ['MODELS_BASE_URL', 'ANTHROPIC_BASE_URL', 'MODELS_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CONFIG_DIR'] as const;
    const saved = keys.map(key => process.env[key]);
    for (const key of keys) delete process.env[key];
    process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), 'no-claude-config-for-api-session-commands');
    resetModelCatalogCache(); resetSettingsEnvCache();
    const fetchSpy = jest.spyOn(global, 'fetch');
    let reply: Awaited<ReturnType<AgentRunner['executeApiCommand']>>;
    try { reply = await runner.executeApiCommand(sessionId, chatId, '/models', { skipPersist: true }); } finally {
      keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
      resetModelCatalogCache(); resetSettingsEnvCache();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    const { result, responseText } = reply;
    expect(responseText).toContain('Current model: claude-opus-4-6');
    expect(responseText).toContain('PUT /api/v1/agents/:agentId/model');
    expect(responseText).not.toContain('/model <id');
    expect(result.model).toBe('claude-opus-4-6');
    expect((result.models as Array<{ id: string; current: boolean }>).find(m => m.current)?.id).toBe('claude-opus-4-6');
  });

  it('/new creates a named API session and returns its ID; /rename renames this one', async () => {
    const created = await runner.executeApiCommand(sessionId, chatId, '/new Design', { skipPersist: true });
    const index = await getSessionStore(runner).listSessions(agentId, chatId, 'api');
    expect(index.sessions.find(s => s.id === created.result.sessionId)?.name).toBe('Design');
    expect(created.responseText).toContain('"Design"');

    const renamed = await runner.executeApiCommand(sessionId, chatId, '/rename Design review', { skipPersist: true });
    expect(renamed.responseText).toBe('✅ Session renamed to "Design review"');
    expect((await getSessionStore(runner).listSessions(agentId, chatId, 'api')).sessions.find(s => s.id === sessionId)?.name).toBe('Design review');
    expect((await runner.executeApiCommand(sessionId, chatId, '/rename', { skipPersist: true })).responseText).toContain('Usage: /rename');
  });

  // Review of #591 (L5): without session_id the API runs a command in a fresh session,
  // so /new left that one behind empty beside the session it created, and /rename named it.
  it('without session_id, /new names the fresh session and /rename refuses', async () => {
    const fresh = 'f0f0f0f0-0000-4000-8000-000000000001';
    const before = (await getSessionStore(runner).listSessions(agentId, chatId, 'api')).sessions.length;
    const created = await runner.executeApiCommand(fresh, chatId, '/new Design', { skipPersist: true, implicitSession: true });
    expect(created.result).toEqual({ sessionId: fresh, sessionName: 'Design' });
    const after = (await getSessionStore(runner).listSessions(agentId, chatId, 'api')).sessions;
    expect(after).toHaveLength(before + 1);
    expect(after.find(s => s.id === fresh)?.name).toBe('Design');

    const other = 'f0f0f0f0-0000-4000-8000-000000000002';
    const renamed = await runner.executeApiCommand(other, chatId, '/rename Oops', { skipPersist: true, implicitSession: true });
    expect(renamed.result).toEqual({ error: 'SESSION_ID_REQUIRED' });
    expect(renamed.responseText).toContain('session_id');
    expect((await getSessionStore(runner).listSessions(agentId, chatId, 'api')).sessions.find(s => s.id === other)).toBeUndefined();
  });

  it('/tasks, /voice and /voices answer without orchestration instead of reaching the model', async () => {
    expect((await runner.executeApiCommand(sessionId, chatId, '/tasks', { skipPersist: true, principalId: 'owner' })).responseText).toBe('Task controls require orchestration mode.');
    for (const command of ['/voice', '/voice on', '/voices']) {
      expect((await runner.executeApiCommand(sessionId, chatId, command, { skipPersist: true })).responseText).toContain('/voice-settings');
    }
  });

  test('/tasks opens the task browser with /orch actions bound to this session and principal', async () => {
    const store=new OrchestrationStore(':memory:',agentId),tasks=new TaskService(store),decisions=new DecisionService(store);
    try{
      const input=store.acceptInput({scope:{agentId,agentSessionId:sessionId,source:'api',accountId:'owner',chatId,threadKey:'',principalId:'owner'},text:'Work'});
      const decision=decisions.begin(input.conversationId,'owner',[input.inputId]);
      tasks.spawn({...input,...decision,principalId:'owner',actionId:'spawn',execute:true,writeMemory:false},{title:'Review PR',instructions:'fixture',targetProfile:'default-worker'});
      const stop=new StopControls(store,tasks,()=>false);
      (runner as any).agentConfig.orchestration={enabled:true,channels:['api']};
      (runner as any).orchestration={ownsSession:()=>false,canReturnToLegacy:()=>true,stopControls:stop,channelControls:new ChannelControls(store,new TaskControls(store,tasks),stop,{} as any,()=>false),authorizeSession:(_s:string,p:string)=>store.assertMember(input.conversationId,p)};
      const list=await runner.executeApiCommand(sessionId,chatId,'/tasks',{skipPersist:true,principalId:'owner'});
      expect(list.responseText).toContain('1. Review PR');
      const open=list.actions.find(a=>a.label.startsWith('1. Review PR'))!;
      expect(open.command).toMatch(/^\/orch [0-9a-f-]{36}$/);
      const detail=await runner.executeApiCommand(sessionId,chatId,open.command,{skipPersist:true,principalId:'owner'});
      expect(detail.responseText).toContain('Review PR\nStatus:');
      expect(detail.actions.map(a=>a.label)).toContain('Back');
      // Another principal cannot use the token.
      await expect(runner.executeApiCommand(sessionId,chatId,open.command,{skipPersist:true,principalId:'intruder'})).rejects.toThrow();

      const menu=await runner.executeApiCommand(sessionId,chatId,'/stop',{skipPersist:true,principalId:'owner'});
      expect(menu.actions).toEqual([{label:expect.stringContaining('1. Review PR'),command:expect.stringMatching(/^\/stop [0-9a-f-]{36} 1$/)},{label:'Dismiss',command:expect.stringMatching(/ 0$/)}]);
    }finally{(runner as any).orchestration=undefined;store.close();}
  });

  describe('/pstack-setup menu actions', () => {
    const { pstackClaudeConfig } = require('../helpers/pstack-fixture');
    let fixture: { configDir: string; cleanup: () => void };
    // Third review of #591 (L13): restore the earlier value rather than delete it.
    let previousConfigDir: string | undefined;
    beforeEach(() => { fixture = pstackClaudeConfig(); previousConfigDir = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = fixture.configDir; });
    afterEach(() => { fixture.cleanup(); if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousConfigDir; });

    it('returns the Telegram menu buttons as /pstack-setup ps:… actions and walks them', async () => {
      const home = await runner.executeApiCommand(sessionId, chatId, '/pstack-setup', { skipPersist: true });
      expect(home.responseText).toContain('Usage: /pstack-setup');
      expect(home.actions).toEqual([{ label: '✅ Turn on', command: '/pstack-setup ps:on' }, { label: 'Effort: session', command: '/pstack-setup ps:de' }, { label: 'Roles ▸', command: '/pstack-setup ps:g' }, { label: 'Reset all', command: '/pstack-setup ps:rs' }, { label: 'Close', command: '/pstack-setup ps:x' }]);
      expect(home.responseText).toContain('• interrogate reviewers: ');
      const effort = await runner.executeApiCommand(sessionId, chatId, '/pstack-setup ps:de', { skipPersist: true });
      expect(effort.responseText).toContain('Default effort: session');
      expect(effort.actions).toContainEqual({ label: '◀ Back', command: '/pstack-setup ps:h' });
      const roles = await runner.executeApiCommand(sessionId, chatId, '/pstack-setup ps:g', { skipPersist: true });
      expect(roles.actions).toEqual([{ label: 'Single-model ▸ (13)', command: '/pstack-setup ps:l:s:0' }, { label: 'Panels ▸ (4)', command: '/pstack-setup ps:l:p:0' }, { label: '◀ Back', command: '/pstack-setup ps:h' }]);
      const panels = await runner.executeApiCommand(sessionId, chatId, '/pstack-setup ps:l:p:0', { skipPersist: true });
      expect(panels.responseText).toContain('Panel roles');
      expect(panels.actions).toContainEqual({ label: 'interrogate reviewers · 4 models', command: `/pstack-setup ps:r:16-${createHash('sha256').update('interrogate reviewers').digest('hex').slice(0, 3)}` });
      expect((await runner.executeApiCommand(sessionId, chatId, '/pstack-setup ps:x', { skipPersist: true })).actions).toEqual([]);
    });

    it('a change from a button needs write access to the agent', async () => {
      const refused = await runner.executeApiCommand(sessionId, chatId, '/pstack-setup ps:on', { skipPersist: true });
      expect(refused.responseText).toContain('needs an API key with write access');
      expect((runner as any).agentConfig.pstack).toBeUndefined();
    });
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
