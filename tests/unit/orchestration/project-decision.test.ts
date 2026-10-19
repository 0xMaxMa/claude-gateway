import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { SessionStore } from '../../../src/session/store';
import { HistoryDB } from '../../../src/history/db';
import type { ProjectName } from '../../../src/projects/paths';
import type { SessionProcess } from '../../../src/session/process';
import type { AgentConfig, GatewayConfig } from '../../../src/types';

test('the deciding agent of a project chat is told its project in the stable system overlay, and keeps its workspace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'project-decision-')), dir = join(root, 'a'), workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true }); writeFileSync(join(workspace, 'CLAUDE.md'), 'Identity');
  const agent = { id: 'a', description: 'fixture', env: '', workspace, claude: { model: 'fixture', extraFlags: [] } } as AgentConfig;
  const gateway = { gateway: { orchestration: true, headless: true }, agents: [agent] } as GatewayConfig;
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a'), bound = randomUUID(), unbound = randomUUID();
  await sessions.ensureApiSession('a', 'chat', bound); await sessions.ensureApiSession('a', 'chat', unbound);
  const overlays = new Map<string, string[]>(), prompts: string[] = [];
  const runtime = await AgentOrchestrationRuntime.open(agent, gateway, dir, sessions, history, {
    skills: () => ({ skills: new Map(), cliSkills: [] } as any),
    sessionProject: async scope => scope.agentSessionId === bound ? { ok: true, value: { name: 'demo' as ProjectName, dir: '/srv/projects/demo', trusted: false, identity: '1:1' } } : undefined,
    createAgentSession: async (id, profile) => Object.assign(new EventEmitter(), {
      start: async () => {}, stop: async () => {},
      sendMessage: function (this: EventEmitter, prompt: string) {
        overlays.set(id, [...overlays.get(id) ?? [], profile.overlay!]); prompts.push(prompt);
        this.emit('output', JSON.stringify({ type: 'result', result: 'Done.' }));
      },
    }) as unknown as SessionProcess, releaseAgentSession: async () => {},
  });
  const scope = (agentSessionId: string) => ({ agentId: 'a', agentSessionId, source: 'api' as const, accountId: 'owner', chatId: 'chat', threadKey: '', principalId: 'owner' });
  try {
    for (const text of ['Fix the footer', 'And the header']) await runtime.send({ scope: scope(bound), text }, { execute: true, writeMemory: false }, { timeoutMs: 2000 });
    await runtime.send({ scope: scope(unbound), text: 'Hello' }, { execute: true, writeMemory: false }, { timeoutMs: 2000 });
    const [first, second] = overlays.get(bound)!;
    expect(first).toContain('You are working in project demo at /srv/projects/demo.');
    expect(second).toBe(first);
    expect(prompts.join('\n')).not.toContain('/srv/projects/demo');
    expect(overlays.get(unbound)![0]).not.toContain('You are working in project');
  } finally { await runtime.close(); (history as never as { db: { close(): void } }).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true }); }
});
