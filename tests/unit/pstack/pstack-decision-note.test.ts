import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { SessionStore } from '../../../src/session/store';
import { HistoryDB } from '../../../src/history/db';
import type { SessionProcess } from '../../../src/session/process';
import type { AgentConfig, GatewayConfig } from '../../../src/types';

// The decision turn lists the pstack:* skills but was never told what pstack is, so it read
// "pstack" as the Unix process-stack tool. A set-up agent's overlay names the plugin; any other
// agent's overlay is unchanged, and a /pstack-setup toggle applies on the next turn.
test('the decision overlay names the pstack plugin only while pstack is set up', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pstack-note-')), dir = join(root, 'a'), workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true }); writeFileSync(join(workspace, 'CLAUDE.md'), 'Identity');
  const agent = { id: 'a', description: 'fixture', env: '', workspace, claude: { model: 'fixture', extraFlags: [] } } as AgentConfig;
  const gateway = { gateway: { orchestration: true, headless: true }, agents: [agent] } as GatewayConfig;
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a'), sid = randomUUID();
  await sessions.ensureApiSession('a', 'chat', sid);
  const overlays: string[] = [];
  const runtime = await AgentOrchestrationRuntime.open(agent, gateway, dir, sessions, history, {
    createAgentSession: async (_id, profile) => { overlays.push(profile.overlay ?? ''); return Object.assign(new EventEmitter(), {
      runtimeProfile: profile, start: async () => {}, stop: async () => {},
      sendMessage: function (this: EventEmitter) {
        this.emit('output', JSON.stringify({ type: 'system', subtype: 'init', tools: [] }));
        this.emit('output', JSON.stringify({ type: 'result', result: 'Done.' }));
      },
    }) as unknown as SessionProcess; }, releaseAgentSession: async () => {},
  });
  const scope = { agentId: 'a', agentSessionId: sid, source: 'api' as const, accountId: 'owner', chatId: 'chat', threadKey: '', principalId: 'owner' };
  const turn = async () => {
    const before = overlays.length;
    await runtime.send({ scope, text: 'What is pstack?' }, { execute: true, writeMemory: false }, { timeoutMs: 2000 });
    expect(overlays.length).toBeGreaterThan(before); // a fresh profile was built for this turn
    return overlays.at(-1)!;
  };
  // The runtime keeps and mutates this agent object; toggle from an unchanged copy.
  const base = { ...agent };
  try {
    const off = await turn();
    expect(off).not.toMatch(/pstack@pstack-claude|Unix/);

    runtime.updateAgentConfig({ ...base, pstack: { defaultEffort: 'session' } });
    const on = await turn();
    expect(on).toContain('pstack@pstack-claude');
    expect(on).toContain('not the Unix');
    expect(on).toContain('target_profile=skill-worker');
    expect(on).toContain('pstack:poteto-mode');
    // Session 66f2f9db: asked how to set pstack up, the agent pointed at upstream setup-pstack.
    expect(on).toContain('/pstack-setup (roles, models, effort, on/off)');
    expect(on).toContain('not pstack\'s setup-pstack');
    // The note is the only difference, so pstack-off agents keep today's overlay byte for byte.
    const note = on.slice(on.indexOf('\n# pstack'), on.indexOf('\n', on.indexOf('setup-pstack')));
    expect(on.replace(note, '')).toBe(off);
    expect(note.length).toBeLessThan(600);

    runtime.updateAgentConfig({ ...base });
    expect(await turn()).toBe(off);
  } finally {
    await runtime.close(); (history as any).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true });
  }
});
