import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { AgentRunner } from '../../../src/agent/runner';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { SessionProcess } from '../../../src/session/process';
import { SessionStore } from '../../../src/session/store';
import { HistoryDB } from '../../../src/history/db';
import { AgentConfig, GatewayConfig } from '../../../src/types';

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'api-admission-'));
  const dir = join(root, 'a'), workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'CLAUDE.md'), 'Fixture');
  const agent = { id: 'a', description: 'fixture', env: '', workspace,
    claude: { model: 'fixture', extraFlags: [] }, orchestration: { enabled: true } } as AgentConfig;
  const config = { gateway: { orchestration: true, headless: true }, agents: [agent] } as GatewayConfig;
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a'), sid = randomUUID();
  await sessions.ensureApiSession('a', 'client', sid);
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  let process!: EventEmitter;
  const runtime = await AgentOrchestrationRuntime.open(agent, config, dir, sessions, history, {
    createAgentSession: async (_id, profile) => {
      process = Object.assign(new EventEmitter(), { runtimeProfile: profile, start: async () => {},
        interrupt: () => {}, stop: async () => {}, sendMessage: () => ready() });
      return process as SessionProcess;
    }, releaseAgentSession: async () => {},
  });
  const foreground = runtime.send({ scope: { agentId: 'a', agentSessionId: sid, source: 'api',
    accountId: 'owner', chatId: 'client', threadKey: '', principalId: 'owner' }, text: 'Hold response' },
    { execute: false, writeMemory: false }, { timeoutMs: 30000 });
  void foreground.catch(() => {});
  await started;
  const facade = Object.assign(Object.create(AgentRunner.prototype), {
    agentConfig: agent, sessionStore: sessions, agentsBaseDir: root, apiChatIds: new Map(),
    pendingApiSessions: new Set([sid]), logger: { warn: jest.fn() }, getOrchestration: async () => runtime,
  }) as AgentRunner;
  const upload = 'media/ui-upload/fixture.txt';
  mkdirSync(join(dir, 'media', 'ui-upload'), { recursive: true });
  writeFileSync(join(dir, upload), 'attachment bytes');
  const opts = { timeoutMs: 5000, principalId: 'owner', clientMessageId: randomUUID(), mediaFiles: [upload] };
  return { dir, sid, runtime, facade, sessions, history, upload, opts,
    async close() {
      // Finish the fixture response before shutdown rather than waiting for its timeout.
      runtime.drain();
      process.emit('output', JSON.stringify({ type: 'result', result: 'Finished' }));
      await foreground.catch(() => {});
      await runtime.close();
      (history as any).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true });
    },
  };
}

test('attachment retries reuse a durable receipt even after staging cleanup and changed defaults', async () => {
  const f = await fixture();
  try {
    const first = await f.facade.acceptApiMessage(f.sid, 'client', 'Inspect', f.opts);
    const row = f.history.getUserMessagesAfter(f.sid, 0).find(message => message.inputId === first)!;
    expect(readFileSync(join(f.dir, row.mediaFiles![0]), 'utf8')).toBe('attachment bytes');
    rmSync(join(f.dir, f.upload));
    await f.sessions.updateSessionMeta('a', 'client', f.sid, { imageConfig: { model: 'new-default' } }, 'api');
    expect(await f.facade.acceptApiMessage(f.sid, 'client', 'Inspect', f.opts)).toBe(first);
    expect(f.history.getUserMessagesAfter(f.sid, 0).filter(message => message.inputId === first)).toHaveLength(1);
    expect(readdirSync(join(f.dir, 'media', `api-${f.sid}`))).toHaveLength(1);
    for (const changed of [{ message: 'Changed' }, { mediaFiles: ['media/ui-upload/other.txt'] }, { model: 'other' }]) {
      const { message = 'Inspect', ...options } = changed;
      await expect(f.facade.acceptApiMessage(f.sid, 'client', message, { ...f.opts, ...options }))
        .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    }
    await expect(f.facade.acceptApiMessage(f.sid, 'client', 'Inspect', { ...f.opts, principalId: 'outsider' }))
      .rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  } finally { await f.close(); }
});

test('concurrent retries create one input and keep only its prepared copy', async () => {
  const f = await fixture();
  try {
    const ids = await Promise.all(Array.from({ length: 4 }, () => f.facade.acceptApiMessage(f.sid, 'client', 'Inspect', f.opts)));
    expect(new Set(ids).size).toBe(1);
    expect(f.history.getUserMessagesAfter(f.sid, 0).filter(message => message.inputId === ids[0])).toHaveLength(1);
    expect(readdirSync(join(f.dir, 'media', `api-${f.sid}`))).toHaveLength(1);
    const row = f.history.getUserMessagesAfter(f.sid, 0).find(message => message.inputId === ids[0])!;
    expect(readFileSync(join(f.dir, row.mediaFiles![0]), 'utf8')).toBe('attachment bytes');
  } finally { await f.close(); }
});

test('full queue leaves the upload usable and removes rejected preparation before retry', async () => {
  const f = await fixture();
  try {
    const config = (f.runtime as any).config.conversation;
    config.maxPendingInputs = 1;
    const options = { ...f.opts, imageParams: { model: 'requested-image-model' } };
    await expect(f.facade.acceptApiMessage(f.sid, 'client', 'Inspect', options)).rejects.toMatchObject({ code: 'QUEUE_FULL' });
    expect(readFileSync(join(f.dir, f.upload), 'utf8')).toBe('attachment bytes');
    const index = await f.sessions.loadIndex('a', 'client', 'api');
    expect(index?.sessions.find(session => session.id === f.sid)?.imageConfig).toBeUndefined();
    expect(readdirSync(join(f.dir, 'media', `api-${f.sid}`))).toEqual([]);
    config.maxPendingInputs = 100;
    const id = await f.facade.acceptApiMessage(f.sid, 'client', 'Inspect', f.opts);
    expect(f.history.getUserMessagesAfter(f.sid, 0).find(message => message.inputId === id)?.mediaFiles).toHaveLength(1);
  } finally { await f.close(); }
});

test('a receipt is not reused for the same client UUID in another session', async () => {
  const f = await fixture();
  try {
    const first = await f.facade.acceptApiMessage(f.sid, 'client', 'Inspect', f.opts);
    const other = randomUUID();
    await f.sessions.ensureApiSession('a', 'client', other);
    const second = await f.facade.acceptApiMessage(other, 'client', 'Inspect', f.opts);
    expect(second).not.toBe(first);
    expect(existsSync(join(f.dir, f.upload))).toBe(true);
  } finally { await f.close(); }
});


test('partial preparation failure never admits an unreadable attachment or consumes the draft', async () => {
  const f = await fixture();
  try {
    await expect(f.facade.acceptApiMessage(f.sid, 'client', 'Inspect', {
      ...f.opts, mediaFiles: [f.upload, 'media/ui-upload/missing.txt'],
    })).rejects.toThrow();
    expect(readFileSync(join(f.dir, f.upload), 'utf8')).toBe('attachment bytes');
    expect(readdirSync(join(f.dir, 'media', `api-${f.sid}`))).toEqual([]);
    expect(f.history.getUserMessagesAfter(f.sid, 0).some(message => message.clientMessageId === f.opts.clientMessageId)).toBe(false);
  } finally { await f.close(); }
});
