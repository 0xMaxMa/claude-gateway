import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync, readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { TaskBridge } from '../../../src/orchestration/bridge';
import { TaskFiles } from '../../../src/orchestration/task-files';
import { TaskWorkspaces } from '../../../src/orchestration/tasks/workspace';
import { DeliveryOutbox } from '../../../src/orchestration/delivery';
import { sendChannelFile } from '../../../src/orchestration/file-delivery';
import { workerNarrate, narrationGroups, NarrateConfig } from '../../../src/orchestration/narrate';
import { NarrateModule } from '../../../mcp/tools/narrate/module';
import { VoiceError } from '../../../src/voice/types';
import { AgentConfig } from '../../../src/types';

const agentSession = '7e50cb45-0d71-4695-941c-197f7a86b8bc';
const CONFIG: NarrateConfig = { enabled: true, maxChars: 100000, maxParts: 60, targetChars: 40, partTimeoutMs: 5000 };
const sentence = (n: number) => `This is spoken sentence number ${n}.`;
const make = (count: number) => Array.from({ length: count }, (_, i) => sentence(i + 1)).join(' ');
const duration = (file: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'narrate-')), workspace = join(root, 'agent', 'workspace'); mkdirSync(workspace, { recursive: true });
  const store = new OrchestrationStore(join(root, 'orchestration.db'), 'agent'), tasks = new TaskService(store), files = new TaskFiles(store, root);
  const send = jest.fn(async () => ({ state: 'delivered' as const, providerId: 'receipt' }));
  const delivery = new DeliveryOutbox(store, send), decisions = new DecisionService(store, (r, b, t) => delivery.enqueue(r, b, t));
  const scope = { agentId: 'agent', agentSessionId: agentSession, source: 'telegram' as const, accountId: 'bot', chatId: '123', threadKey: '', principalId: 'user' };
  const input = store.acceptInput({ scope, text: 'read this aloud' }), decision = decisions.begin(input.conversationId, 'user', [input.inputId]);
  const ctx = { ...input, ...decision, principalId: 'user', execute: true, writeMemory: false, actionId: 'spawn' };
  const task = tasks.spawn(ctx, { title: 'narrate', instructions: 'fixture', targetProfile: 'media-worker' }); decisions.finish(decision, 'Queued.'); await delivery.tick(); send.mockClear();
  const attempt = tasks.claim(task.taskId)!;
  const resources = new TaskWorkspaces(store, '/nonexistent-project', join(root, 'resources'), 'isolated-worktree');
  const resource = await resources.prepare(task.taskId); tasks.started(attempt.attemptId, attempt.generation);
  const calls: string[] = [];
  const provider = (behaviour: (call: number, text: string, signal: AbortSignal) => void = () => {}) => () => ({
    id: 'fake', capabilities: { textStreaming: false, wordAlignment: false, outputFormats: [] },
    synthesize: async function* () {},
    synthesizeFile: async (o: { text: string; voiceId: string; signal: AbortSignal }) => {
      calls.push(o.text); behaviour(calls.length, o.text, o.signal);
      const file = join(root, `tone-${calls.length}.mp3`);
      execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${200 + calls.length * 40}:duration=0.3`, '-ar', '24000', '-ac', '1', '-b:a', '48k', file]);
      return { bytes: new Uint8Array(require('fs').readFileSync(file)), mime: 'audio/mpeg' as const, name: 'reply.mp3' };
    },
  });
  const narrate = (overrides: Partial<NarrateConfig> = {}, p = provider(), extra: Record<string, unknown> = {}) => workerNarrate({
    files, config: () => ({ ...CONFIG, ...overrides }), settings: () => ({ provider: 'fake', model: 'm', voiceId: 'v' }), provider: p as any, voice: async () => 'v', ...extra });
  const staged = () => store.all('SELECT name,kind,path FROM task_files WHERE attempt_id=? ORDER BY created_at,id', attempt.attemptId);
  return { root, store, files, tasks, decisions, delivery, send, attempt, resource, calls, provider, narrate, staged, scope,
    run: (n: ReturnType<typeof narrate>, args: Record<string, unknown>, signal = new AbortController().signal) => n(attempt.attemptId, attempt.generation, 'act', args, signal),
    close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

describe('narrationGroups', () => {
  test('one file per part up to ten, otherwise adjacent parts are packed evenly', () => {
    expect(narrationGroups(3)).toEqual([[0], [1], [2]]);
    const groups = narrationGroups(25);
    expect(groups).toHaveLength(10);
    expect(groups.flat()).toEqual(Array.from({ length: 25 }, (_, i) => i));
    expect(Math.max(...groups.map(g => g.length)) - Math.min(...groups.map(g => g.length))).toBeLessThanOrEqual(1);
  });
});

describe('narrate service', () => {
  test('synthesizes every piece once, in order, and stages ordered audio files', async () => {
    const f = await fixture();
    try {
      const text = make(6);
      const result = await f.run(f.narrate(), { text });
      expect(result).toEqual({ ok: true, parts_total: f.calls.length, parts_staged: f.calls.length, files: f.calls.length, chars: text.length });
      expect(f.calls.join('')).toBe(text);
      const rows = f.staged();
      expect(rows.map(r => r.name)).toEqual(f.calls.map((_, i) => `narration-${String(i + 1).padStart(2, '0')}-of-${String(f.calls.length).padStart(2, '0')}.mp3`));
      expect(rows.every(r => r.kind === 'audio')).toBe(true);
      expect(readdirSync(join(f.root, 'agent', 'media', `api-${agentSession}`)).filter(n => n.startsWith('narrate-'))).toEqual([]);
    } finally { f.close(); }
  });

  test('more than ten pieces are merged in order into ten files', async () => {
    const f = await fixture();
    try {
      const text = make(25);
      const result = await f.run(f.narrate({ targetChars: 40 }), { text });
      expect(result.parts_total).toBe(f.calls.length);
      expect(f.calls.length).toBeGreaterThan(10);
      expect(result).toMatchObject({ ok: true, parts_staged: f.calls.length, files: 10 });
      const rows = f.staged();
      expect(rows).toHaveLength(10);
      expect(rows[0].name).toBe('narration-01-of-10.mp3');
      const total = rows.reduce((sum, r) => sum + duration(join(f.root, 'agent', String(r.path))), 0);
      expect(total).toBeGreaterThan(f.calls.length * 0.3 * 0.9);
      expect(total).toBeLessThan(f.calls.length * 0.3 * 1.5);
    } finally { f.close(); }
  });

  test('files already staged by the worker reduce the room for narration files', async () => {
    const f = await fixture();
    try {
      const other = join(f.resource.path, 'note.txt'); writeFileSync(other, 'note');
      for (let i = 0; i < 4; i++) f.files.stage(f.attempt.attemptId, f.attempt.generation, `pre-${i}`, { path: other, caption: String(i) });
      const result = await f.run(f.narrate(), { text: make(25) });
      expect(result).toMatchObject({ ok: true, files: 6 });
      expect(f.staged()).toHaveLength(10);
    } finally { f.close(); }
  });

  test('ffmpeg missing for a merge fails before any TTS call', async () => {
    const f = await fixture();
    try {
      await expect(f.run(f.narrate({}, f.provider(), { ffmpegAvailable: async () => false }), { text: make(25) })).rejects.toMatchObject({ code: 'NARRATE_FFMPEG_MISSING' });
      expect(f.calls).toHaveLength(0);
    } finally { f.close(); }
  });

  test('failure at piece 3 returns the partial result and stops', async () => {
    const f = await fixture();
    try {
      const n = f.narrate({}, f.provider(call => { if (call === 3) throw new VoiceError('TTS_PROVIDER_ERROR'); }));
      const result = await f.run(n, { text: make(6) });
      expect(result).toMatchObject({ ok: false, parts_staged: 2, files: 2, stopped_reason: 'NARRATE_TTS_FAILED:TTS_PROVIDER_ERROR' });
      expect(f.calls).toHaveLength(3);
      expect(f.staged()).toHaveLength(2);
    } finally { f.close(); }
  });

  test('managed quota exhaustion stops and keeps the pieces already produced', async () => {
    const f = await fixture();
    try {
      const n = f.narrate({}, f.provider(call => { if (call === 3) throw new VoiceError('MANAGED_VOICE_QUOTA_EXHAUSTED'); }));
      const result = await f.run(n, { text: make(6) });
      expect(result).toMatchObject({ ok: false, parts_staged: 2, stopped_reason: 'NARRATE_QUOTA_EXHAUSTED' });
      expect(f.calls).toHaveLength(3);
    } finally { f.close(); }
  });

  test('cancellation aborts the TTS call and stages nothing', async () => {
    const f = await fixture();
    try {
      const abort = new AbortController();
      const n = f.narrate({}, f.provider((call) => { if (call === 2) abort.abort(); }));
      await expect(f.run(n, { text: make(6) }, abort.signal)).rejects.toMatchObject({ code: 'NARRATE_CANCELLED' });
      expect(f.calls).toHaveLength(2);
      expect(f.staged()).toHaveLength(0);
    } finally { f.close(); }
  });

  test('guards report the config key and value', async () => {
    const f = await fixture();
    try {
      await expect(f.run(f.narrate({ maxChars: 50 }), { text: make(6) })).rejects.toMatchObject({ code: 'NARRATE_TOO_LONG', message: expect.stringContaining('voice.narrate.maxChars=50') });
      await expect(f.run(f.narrate({ maxParts: 2 }), { text: make(6) })).rejects.toMatchObject({ code: 'NARRATE_TOO_LONG', message: expect.stringContaining('voice.narrate.maxParts=2') });
      await expect(f.run(f.narrate({ enabled: false }), { text: 'hello there' })).rejects.toMatchObject({ code: 'NARRATE_DISABLED' });
      await expect(f.run(f.narrate(), { text: '   \n ' })).rejects.toMatchObject({ code: 'NARRATE_EMPTY' });
      await expect(f.run(f.narrate(), { text: '--- *** ...' })).rejects.toMatchObject({ code: 'NARRATE_EMPTY' });
      await expect(f.run(f.narrate(), { text: 'a', path: 'b' })).rejects.toMatchObject({ code: 'NARRATE_ARGS_INVALID' });
      await expect(f.run(f.narrate(), {})).rejects.toMatchObject({ code: 'NARRATE_ARGS_INVALID' });
      await expect(f.run(f.narrate(), { text: 'a', url: 'https://example.com' })).rejects.toMatchObject({ code: 'NARRATE_ARGS_INVALID' });
      expect(f.calls).toHaveLength(0);
    } finally { f.close(); }
  });

  test('symbol-only fragments are folded into a neighbour so the spoken text equals the source', async () => {
    const f = await fixture();
    try {
      const text = 'Hello world, this is one.\n\n-----\n\nAnd this is two.';
      await f.run(f.narrate({ targetChars: 26 }), { text });
      expect(f.calls.join('')).toBe(text);
    } finally { f.close(); }
  });

  test('a retry with the same action id is idempotent and an over-long symbol run is rejected', async () => {
    const f = await fixture();
    try {
      const n = f.narrate();
      await f.run(n, { text: make(3) });
      await expect(f.run(n, { text: make(3) })).resolves.toMatchObject({ ok: true });
      expect(f.staged()).toHaveLength(f.calls.length / 2);
      await expect(f.run(f.narrate({ targetChars: 3000 }), { text: `Hello there.\n\n${'-'.repeat(5000)}` })).rejects.toMatchObject({ code: 'NARRATE_EMPTY' });
    } finally { f.close(); }
  });

  test('a retry after a full ten-file narration plans the same groups and stays idempotent', async () => {
    const f = await fixture();
    try {
      const n = f.narrate({ targetChars: 30, maxParts: 60 });
      const first = await f.run(n, { text: make(14) });
      expect(first.files).toBe(10);
      const before = f.staged().length;
      await expect(f.run(n, { text: make(14) })).resolves.toMatchObject({ ok: true, files: 10 });
      expect(f.staged()).toHaveLength(before);
    } finally { f.close(); }
  });

  describe('path input', () => {
    test('a file inside the task scope is narrated; content never appears in errors', async () => {
      const f = await fixture();
      try {
        const inside = join(f.resource.path, 'page.txt'); writeFileSync(inside, 'Spoken from a file. Second sentence here.');
        expect(await f.run(f.narrate(), { path: inside })).toMatchObject({ ok: true });
        expect(f.calls.join('')).toBe('Spoken from a file. Second sentence here.');
        const outsideDir = mkdtempSync(join(tmpdir(), 'narrate-out-')), secret = 'TOP-SECRET-CONTENT';
        writeFileSync(join(outsideDir, 'secret.txt'), secret);
        symlinkSync(join(outsideDir, 'secret.txt'), join(f.resource.path, 'link.txt'));
        const before = f.calls.length;
        for (const path of [join(outsideDir, 'secret.txt'), join(f.resource.path, '..', '..', '..', 'secret.txt'), join(f.resource.path, 'link.txt'), f.resource.path, join(f.resource.path, 'missing.txt')]) {
          const error = await f.run(f.narrate(), { path }).catch(e => e);
          expect(error.code).toBe('NARRATE_PATH_DENIED');
          expect(error.message).not.toContain(secret);
        }
        expect(f.calls).toHaveLength(before);
        rmSync(outsideDir, { recursive: true, force: true });
      } finally { f.close(); }
    });
    test('an oversized file is rejected before it is read', async () => {
      const f = await fixture();
      try {
        const big = join(f.resource.path, 'big.txt'); writeFileSync(big, 'x'.repeat(600));
        await expect(f.run(f.narrate({ maxChars: 100 }), { path: big })).rejects.toMatchObject({ code: 'NARRATE_FILE_TOO_LARGE', message: expect.stringContaining('voice.narrate.maxChars=100') });
      } finally { f.close(); }
    });
  });

  test('the bridge routes narrate for a live worker ticket and denies it after revoke', async () => {
    const f = await fixture();
    const bridge = new TaskBridge(f.tasks, f.files);
    const seen: string[] = [];
    bridge.narrateCall = async (_a, _g, _id, args, signal) => { seen.push(String(args.text)); return { ok: true, aborted: signal.aborted }; };
    try {
      await bridge.start();
      const directory = join(f.root, 'ticket');
      const issued = bridge.issue({ role: 'worker', attemptId: f.attempt.attemptId, generation: f.attempt.generation }, directory, join(f.root, 'agent', 'workspace'));
      const ticket = JSON.parse(require('fs').readFileSync(join(directory, 'ticket.json'), 'utf8'));
      const call = (tool: string) => fetch(ticket.url, { method: 'POST', headers: { Authorization: `Bearer ${ticket.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ tool, action_id: 'a1', args: { text: 'hi there' } }) }).then(r => r.json());
      expect(await call('narrate')).toEqual({ ok: true, aborted: false });
      expect(seen).toEqual(['hi there']);
      issued.revoke();
      expect(await call('narrate')).toMatchObject({ error: 'ACCESS_DENIED' });
    } finally { await bridge.close(); f.close(); }
  });

  test('the worker-facing tool says not to summarize and that it cannot fetch URLs', () => {
    const [tool] = new NarrateModule().getTools();
    expect(tool.name).toBe('narrate');
    expect(tool.description).toMatch(/Do NOT summarize/);
    expect(tool.description).toMatch(/cannot fetch URLs/);
    expect(tool.description).toMatch(/Host workers only/);
  });
});

describe('staged audio delivery', () => {
  const mp3 = () => { const out = join(tmpdir(), `narrate-d-${process.pid}.mp3`); execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=duration=0.3', out]); return out; };
  test('Telegram receives staged audio through sendAudio, other kinds are unchanged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'narrate-del-')), agentsRoot = root;
    const workspace = join(root, 'agent', 'workspace'); mkdirSync(join(root, 'agent', 'media', 'c'), { recursive: true }); mkdirSync(workspace, { recursive: true });
    const agent = { id: 'agent', workspace, telegram: { botToken: 'fixture' } } as AgentConfig;
    const audio = join(root, 'agent', 'media', 'c', 'a.mp3'), doc = join(root, 'agent', 'media', 'c', 'd.pdf');
    require('fs').copyFileSync(mp3(), audio); writeFileSync(doc, '%PDF-1.4 fixture');
    const urls: string[] = [], fields: string[][] = [];
    const request = (async (url: string, init: { body: FormData }) => { urls.push(url.split('/').pop()!); fields.push([...init.body.keys()]); return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } })); }) as unknown as typeof fetch;
    const binding = { channel: 'telegram', chat_id: '123', thread_key: '' } as any;
    try {
      await sendChannelFile(agent, binding, { path: 'media/c/a.mp3', name: 'narration-01-of-01.mp3', kind: 'audio', caption: '' }, 'i1', request);
      await sendChannelFile(agent, binding, { path: 'media/c/d.pdf', name: 'd.pdf', kind: 'file', caption: '' }, 'i2', request);
      expect(urls).toEqual(['sendAudio', 'sendDocument']);
      expect(fields[0]).toContain('audio');
      expect(agentsRoot).toBeTruthy();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
