import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { resolveDreamingConfig, DREAMING_DEFAULTS } from '../../src/agent/dreaming/config';
import { gatherTranscript, type DreamHistoryDb } from '../../src/agent/dreaming/gather';
import { coerceReview, runDreamReviewer } from '../../src/agent/dreaming/reviewer';
import { writeDreamAudit } from '../../src/agent/dreaming/audit';
import { DreamingManager } from '../../src/agent/dreaming';
import type { ResolvedDreamingCfg } from '../../src/agent/dreaming/types';
import type { ClaudeSpawnFn } from '../../src/agent/skill-learning/reviewer';

const HOUR = 60 * 60 * 1000;
const NOW = 1_700_000_000_000; // fixed epoch for deterministic windows

// A scripted reviewer spawn returning the claude --output-format json envelope.
function scriptedSpawn(reviewObj: unknown, tokens = { input_tokens: 100, output_tokens: 20 }): ClaudeSpawnFn {
  return async () => ({
    stdout: JSON.stringify({ result: JSON.stringify(reviewObj), usage: tokens }),
  });
}

function makeDb(
  sessions: Array<{ sessionId: string; lastActivity: number }>,
  transcripts: Record<string, Array<{ role: string; content: string; ts: number }>> = {},
): DreamHistoryDb {
  return {
    listSessions: () => sessions,
    getSessionTranscript: (id: string) => transcripts[id] ?? [],
  };
}

function mkWs(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

const cfg = (over: Partial<ResolvedDreamingCfg> = {}): ResolvedDreamingCfg => ({ ...DREAMING_DEFAULTS, ...over });

// ── config ────────────────────────────────────────────────────────────────────
describe('dreaming/config: resolveDreamingConfig', () => {
  it('D-CFG-1: undefined → defaults', () => {
    expect(resolveDreamingConfig()).toEqual(DREAMING_DEFAULTS);
    expect(DREAMING_DEFAULTS.mode).toBe('propose'); // safe default
  });

  it('D-CFG-2: per-agent override wins field-by-field over global', () => {
    const r = resolveDreamingConfig({ dreamHour: 5 }, { dreamHour: 1, lookbackDays: 7 });
    expect(r.dreamHour).toBe(5); // agent wins
    expect(r.lookbackDays).toBe(7); // global fills
    expect(r.quietMinutes).toBe(DREAMING_DEFAULTS.quietMinutes); // default fills
  });

  it('D-CFG-3: invalid dreamTimezone falls back to UTC', () => {
    expect(resolveDreamingConfig({ dreamTimezone: 'Not/AZone' }).dreamTimezone).toBe('UTC');
    expect(resolveDreamingConfig({ dreamTimezone: 'Asia/Bangkok' }).dreamTimezone).toBe('Asia/Bangkok');
  });

  it('D-CFG-4: unknown mode normalizes to propose (never accidentally auto)', () => {
    expect(resolveDreamingConfig({ mode: 'nonsense' as 'propose' }).mode).toBe('propose');
    expect(resolveDreamingConfig({ mode: 'auto' }).mode).toBe('auto');
  });

  it('D-CFG-5: invalid dreamHour (NaN/out-of-range/non-number) falls back to default (no NaN scheduler)', () => {
    expect(resolveDreamingConfig({ dreamHour: NaN }).dreamHour).toBe(DREAMING_DEFAULTS.dreamHour);
    expect(resolveDreamingConfig({ dreamHour: 25 }).dreamHour).toBe(DREAMING_DEFAULTS.dreamHour);
    expect(resolveDreamingConfig({ dreamHour: -1 }).dreamHour).toBe(DREAMING_DEFAULTS.dreamHour);
    expect(resolveDreamingConfig({ dreamHour: 'abc' as unknown as number }).dreamHour).toBe(DREAMING_DEFAULTS.dreamHour);
    expect(resolveDreamingConfig({ dreamHour: 5 }).dreamHour).toBe(5); // valid preserved
  });

  it('D-CFG-6: negative/NaN numeric fields fall back; maxChangesPerRun:0 (disable) preserved', () => {
    expect(resolveDreamingConfig({ lookbackDays: -3 }).lookbackDays).toBe(DREAMING_DEFAULTS.lookbackDays);
    expect(resolveDreamingConfig({ quietMinutes: NaN }).quietMinutes).toBe(DREAMING_DEFAULTS.quietMinutes);
    expect(resolveDreamingConfig({ promotionThreshold: 5 }).promotionThreshold).toBe(DREAMING_DEFAULTS.promotionThreshold);
    expect(resolveDreamingConfig({ maxChangesPerRun: 0 }).maxChangesPerRun).toBe(0); // explicit disable kept
  });
});

// ── gather ──────────────────────────────────────────────────────────────────
describe('dreaming/gather', () => {
  it('D-GAT-1: includes only sessions active within the lookback window', () => {
    const db = makeDb(
      [
        { sessionId: 'recent', lastActivity: NOW - 1 * HOUR },
        { sessionId: 'old', lastActivity: NOW - 10 * 24 * HOUR }, // 10 days → outside 3-day window
      ],
      {
        recent: [{ role: 'user', content: 'hello world', ts: NOW - 1 * HOUR }],
        old: [{ role: 'user', content: 'ancient', ts: NOW - 10 * 24 * HOUR }],
      },
    );
    const g = gatherTranscript(db, cfg({ lookbackDays: 3 }), NOW);
    expect(g.sessionCount).toBe(1);
    expect(g.transcript).toContain('hello world');
    expect(g.transcript).not.toContain('ancient');
    expect(g.lastActivityMs).toBe(NOW - 1 * HOUR); // most recent across ALL sessions
  });

  it('D-GAT-2: empty window → empty transcript, sessionCount 0', () => {
    const db = makeDb([{ sessionId: 's', lastActivity: NOW - 30 * 24 * HOUR }]);
    const g = gatherTranscript(db, cfg({ lookbackDays: 3 }), NOW);
    expect(g.transcript).toBe('');
    expect(g.sessionCount).toBe(0);
  });

  it('D-GAT-3: DB error degrades to empty (never throws)', () => {
    const db: DreamHistoryDb = {
      listSessions: () => {
        throw new Error('db down');
      },
      getSessionTranscript: () => [],
    };
    expect(() => gatherTranscript(db, cfg(), NOW)).not.toThrow();
    expect(gatherTranscript(db, cfg(), NOW).transcript).toBe('');
    expect(gatherTranscript(db, cfg(), NOW).lastActivityMs).toBe(0);
  });
});

// ── reviewer coercion ─────────────────────────────────────────────────────────
describe('dreaming/reviewer: coerceReview', () => {
  it('D-REV-1: valid proposals pass; summary retained', () => {
    const r = coerceReview(
      {
        summary: 'found a pref',
        proposals: [{ op: 'add', file: 'USER.md', content: 'prefers dark mode', reason: 'recurs', score: 0.9, recallCount: 3 }],
      },
      120,
    );
    expect(r.summary).toBe('found a pref');
    expect(r.proposals).toHaveLength(1);
    expect(r.tokensSpent).toBe(120);
  });

  it('D-REV-2: malformed / invalid proposals are dropped', () => {
    const r = coerceReview(
      {
        proposals: [
          { op: 'frobnicate', file: 'MEMORY.md', content: 'x', reason: 'r' }, // bad op
          { op: 'add', file: 'SECRETS.md', content: 'x', reason: 'r' }, // bad file
          { op: 'add', file: 'MEMORY.md', reason: 'r' }, // add without content
          { op: 'remove', file: 'MEMORY.md', reason: 'r' }, // remove without target
          { op: 'replace', file: 'MEMORY.md', target: 'old', content: 'new', reason: 'ok', score: 0.5, recallCount: 2 }, // valid
        ],
      },
      0,
    );
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0].op).toBe('replace');
  });

  it('D-REV-3: non-object → empty proposals', () => {
    expect(coerceReview('nope', 0).proposals).toEqual([]);
    expect(coerceReview(null, 0).proposals).toEqual([]);
  });

  it('D-REV-3b: Infinity recallCount → 0; oversized fields are capped (untrusted-input defense)', () => {
    const big = 'x'.repeat(10_000);
    const r = coerceReview(
      {
        summary: big,
        proposals: [{ op: 'add', file: 'MEMORY.md', content: big, reason: big, score: 0.5, recallCount: Infinity }],
      },
      0,
    );
    expect(r.summary.length).toBeLessThanOrEqual(4_000);
    expect(r.proposals[0].recallCount).toBe(0); // Infinity rejected
    expect(r.proposals[0].content!.length).toBeLessThanOrEqual(4_000);
    expect(r.proposals[0].reason.length).toBeLessThanOrEqual(4_000);
  });
});

describe('dreaming/reviewer: runDreamReviewer (scripted spawn)', () => {
  const input = { transcript: 'user: I like X', currentMemory: '', currentUser: '' };

  it('D-REV-4: parses the JSON envelope → proposals + tokens', async () => {
    const spawn = scriptedSpawn({ summary: 's', proposals: [{ op: 'add', file: 'MEMORY.md', content: 'X', reason: 'r', score: 1, recallCount: 2 }] });
    const r = await runDreamReviewer(input, cfg(), spawn);
    expect(r.proposals).toHaveLength(1);
    expect(r.tokensSpent).toBe(120);
  });

  it('D-REV-5: malformed model output → zero proposals, no throw', async () => {
    const spawn: ClaudeSpawnFn = async () => ({ stdout: JSON.stringify({ result: 'not json at all', usage: {} }) });
    const r = await runDreamReviewer(input, cfg(), spawn);
    expect(r.proposals).toEqual([]);
  });

  it('D-REV-6: timeout → zero proposals', async () => {
    const spawn: ClaudeSpawnFn = async () => ({ stdout: '', timedOut: true });
    const r = await runDreamReviewer(input, cfg(), spawn);
    expect(r.proposals).toEqual([]);
    expect(r.timedOut).toBe(true);
  });
});

// ── audit ────────────────────────────────────────────────────────────────────
describe('dreaming/audit: writeDreamAudit', () => {
  it('D-AUD-1: writes DREAMS.md + promotions.jsonl for proposals', () => {
    const ws = mkWs();
    try {
      writeDreamAudit(ws, {
        ts: NOW,
        outcome: 'proposed',
        mode: 'propose',
        summary: 'a dream',
        proposals: [{ op: 'add', file: 'USER.md', content: 'x', reason: 'because', score: 0.8, recallCount: 2 }],
        tokensSpent: 50,
        sessionCount: 1,
      });
      const diary = fs.readFileSync(path.join(ws, '.dreaming', 'DREAMS.md'), 'utf8');
      expect(diary).toContain('proposed');
      expect(diary).toContain('because');
      expect(diary).toContain('memory not modified'); // propose-mode note
      const jsonl = fs.readFileSync(path.join(ws, '.dreaming', 'promotions.jsonl'), 'utf8').trim();
      expect(JSON.parse(jsonl)).toMatchObject({ op: 'add', file: 'USER.md' });
    } finally {
      fs.rmSync(ws, { recursive: true });
    }
  });

  it('D-AUD-1b: auto mode notes the applier is unavailable (fail-closed, no mutation)', () => {
    const ws = mkWs();
    try {
      writeDreamAudit(ws, {
        ts: NOW,
        outcome: 'proposed',
        mode: 'auto',
        summary: 's',
        proposals: [{ op: 'add', file: 'MEMORY.md', content: 'x', reason: 'r', score: 0.9, recallCount: 2 }],
        tokensSpent: 5,
        sessionCount: 1,
      });
      const diary = fs.readFileSync(path.join(ws, '.dreaming', 'DREAMS.md'), 'utf8');
      expect(diary).toContain('applier not yet available');
      expect(diary).toContain('memory not modified');
    } finally {
      fs.rmSync(ws, { recursive: true });
    }
  });

  it('D-AUD-2: no-changes writes a diary note but no jsonl', () => {
    const ws = mkWs();
    try {
      writeDreamAudit(ws, { ts: NOW, outcome: 'no-changes', mode: 'propose', summary: '', proposals: [], tokensSpent: 10, sessionCount: 2 });
      expect(fs.readFileSync(path.join(ws, '.dreaming', 'DREAMS.md'), 'utf8')).toContain('No changes proposed');
      expect(fs.existsSync(path.join(ws, '.dreaming', 'promotions.jsonl'))).toBe(false);
    } finally {
      fs.rmSync(ws, { recursive: true });
    }
  });
});

// ── manager (the core: propose mode mutates NO memory) ──────────────────────────
describe('dreaming/DreamingManager.dreamOnce', () => {
  it('D-MGR-1: propose mode writes diary but does NOT modify MEMORY.md/USER.md', async () => {
    const ws = mkWs({ 'MEMORY.md': 'original memory', 'USER.md': 'original user' });
    try {
      const db = makeDb([{ sessionId: 's1', lastActivity: NOW - 2 * HOUR }], {
        s1: [{ role: 'user', content: 'I always prefer dark mode', ts: NOW - 2 * HOUR }],
      });
      const spawn = scriptedSpawn({
        summary: 'found a durable preference',
        proposals: [{ op: 'add', file: 'USER.md', content: 'prefers dark mode', reason: 'recurring', score: 0.9, recallCount: 3 }],
      });
      const mgr = new DreamingManager({ db, agentId: 'a', workspaceDir: ws, spawnFn: spawn });
      const res = await mgr.dreamOnce(NOW);

      expect(res.outcome).toBe('proposed');
      expect(res.proposalCount).toBe(1);
      // THE core safety property: source memory files are byte-identical.
      expect(fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf8')).toBe('original memory');
      expect(fs.readFileSync(path.join(ws, 'USER.md'), 'utf8')).toBe('original user');
      // Diary + audit written.
      expect(fs.readFileSync(path.join(ws, '.dreaming', 'DREAMS.md'), 'utf8')).toContain('recurring');
      expect(fs.existsSync(path.join(ws, '.dreaming', 'promotions.jsonl'))).toBe(true);
    } finally {
      fs.rmSync(ws, { recursive: true });
    }
  });

  it('D-MGR-2: caps proposals at maxChangesPerRun', async () => {
    const ws = mkWs({ 'MEMORY.md': 'm' });
    try {
      const db = makeDb([{ sessionId: 's1', lastActivity: NOW - 2 * HOUR }], { s1: [{ role: 'user', content: 'lots', ts: NOW - 2 * HOUR }] });
      const many = Array.from({ length: 5 }, (_, i) => ({ op: 'add', file: 'MEMORY.md', content: `c${i}`, reason: 'r', score: 0.7, recallCount: 2 }));
      const mgr = new DreamingManager({ db, agentId: 'a', workspaceDir: ws, globalCfg: { maxChangesPerRun: 2 }, spawnFn: scriptedSpawn({ summary: 's', proposals: many }) });
      const res = await mgr.dreamOnce(NOW);
      expect(res.proposalCount).toBe(2);
    } finally {
      fs.rmSync(ws, { recursive: true });
    }
  });

  it('D-MGR-3: zero proposals → no-changes (diary note, success)', async () => {
    const ws = mkWs({ 'MEMORY.md': 'm' });
    try {
      const db = makeDb([{ sessionId: 's1', lastActivity: NOW - 2 * HOUR }], { s1: [{ role: 'user', content: 'chit chat', ts: NOW - 2 * HOUR }] });
      const mgr = new DreamingManager({ db, agentId: 'a', workspaceDir: ws, spawnFn: scriptedSpawn({ summary: 'nothing durable', proposals: [] }) });
      const res = await mgr.dreamOnce(NOW);
      expect(res.outcome).toBe('no-changes');
      expect(fs.readFileSync(path.join(ws, '.dreaming', 'DREAMS.md'), 'utf8')).toContain('No changes proposed');
    } finally {
      fs.rmSync(ws, { recursive: true });
    }
  });

  it('D-MGR-4: quiet window → skipped, no spawn, no diary', async () => {
    const ws = mkWs({ 'MEMORY.md': 'm' });
    try {
      let spawned = false;
      const spawn: ClaudeSpawnFn = async () => {
        spawned = true;
        return { stdout: '' };
      };
      // last activity 5 min ago, quietMinutes 30 → skip
      const db = makeDb([{ sessionId: 's1', lastActivity: NOW - 5 * 60 * 1000 }], { s1: [{ role: 'user', content: 'busy', ts: NOW - 5 * 60 * 1000 }] });
      const mgr = new DreamingManager({ db, agentId: 'a', workspaceDir: ws, globalCfg: { quietMinutes: 30 }, spawnFn: spawn });
      const res = await mgr.dreamOnce(NOW);
      expect(res.outcome).toBe('skipped-quiet');
      expect(spawned).toBe(false);
      expect(fs.existsSync(path.join(ws, '.dreaming'))).toBe(false);
    } finally {
      fs.rmSync(ws, { recursive: true });
    }
  });

  it('D-MGR-5: enabled:false → skipped-disabled, no spawn, no diary', async () => {
    const ws = mkWs({ 'MEMORY.md': 'm' });
    try {
      let spawned = false;
      const spawn: ClaudeSpawnFn = async () => {
        spawned = true;
        return { stdout: '' };
      };
      const db = makeDb([{ sessionId: 's1', lastActivity: NOW - 2 * HOUR }], { s1: [{ role: 'user', content: 'x', ts: NOW - 2 * HOUR }] });
      const mgr = new DreamingManager({ db, agentId: 'a', workspaceDir: ws, globalCfg: { enabled: false }, spawnFn: spawn });
      const res = await mgr.dreamOnce(NOW);
      expect(res.outcome).toBe('skipped-disabled');
      expect(spawned).toBe(false);
      expect(fs.existsSync(path.join(ws, '.dreaming'))).toBe(false);
    } finally {
      fs.rmSync(ws, { recursive: true });
    }
  });

  it('D-MGR-6: maxChangesPerRun:0 → skipped-disabled', async () => {
    const ws = mkWs({ 'MEMORY.md': 'm' });
    try {
      const db = makeDb([{ sessionId: 's1', lastActivity: NOW - 2 * HOUR }], { s1: [{ role: 'user', content: 'x', ts: NOW - 2 * HOUR }] });
      const mgr = new DreamingManager({ db, agentId: 'a', workspaceDir: ws, globalCfg: { maxChangesPerRun: 0 }, spawnFn: scriptedSpawn({ summary: 's', proposals: [] }) });
      expect((await mgr.dreamOnce(NOW)).outcome).toBe('skipped-disabled');
    } finally {
      fs.rmSync(ws, { recursive: true });
    }
  });

  it('D-MGR-7: empty lookback window → skipped-empty diary note', async () => {
    const ws = mkWs({ 'MEMORY.md': 'm' });
    try {
      const db = makeDb([{ sessionId: 's1', lastActivity: NOW - 30 * 24 * HOUR }]); // outside window
      const mgr = new DreamingManager({ db, agentId: 'a', workspaceDir: ws, spawnFn: scriptedSpawn({ summary: 's', proposals: [] }) });
      const res = await mgr.dreamOnce(NOW);
      expect(res.outcome).toBe('skipped-empty');
      expect(fs.readFileSync(path.join(ws, '.dreaming', 'DREAMS.md'), 'utf8')).toContain('No sessions');
    } finally {
      fs.rmSync(ws, { recursive: true });
    }
  });
});
