import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DreamingManager } from '../../src/agent/dreaming';
import { makeClaudeSpawn, type ClaudeSpawnFn } from '../../src/agent/skill-learning/reviewer';
import { gatherTranscript, type DreamHistoryDb } from '../../src/agent/dreaming/gather';

// Regression suite for #353 — the dream reviewer's failures used to be
// undebuggable: makeClaudeSpawn discarded stderr and collapsed every failure into
// a bare `timedOut`, and the #352 reviewer-catch log was dead code (runDreamReviewer
// never throws). These tests pin the observable behavior: an error run now logs a
// distinguishable reason + stderr tail, on the branch that actually fires.

const HOUR = 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function makeDb(): DreamHistoryDb {
  return {
    listSessions: () => [{ sessionId: 's1', lastActivity: NOW - 2 * HOUR }],
    getSessionTranscript: () => [{ role: 'user', content: 'some durable-looking fact', ts: NOW - 2 * HOUR }],
  };
}

function mkWs(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-diag-'));
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# Memory\n\n- existing fact\n');
  fs.writeFileSync(path.join(dir, 'USER.md'), 'u');
  return dir;
}

type LogEntry = { msg: string; data?: Record<string, unknown> };
function mkLogger(sink: LogEntry[]) {
  return { info: (msg: string, data?: Record<string, unknown>) => sink.push({ msg, data }) };
}

const NO_OUTPUT_LOG = 'dream: reviewer produced no usable output';

describe('dreaming diagnostics (#353): reviewer failures are observable', () => {
  it('DR-1: a timed-out reviewer → outcome=error AND a reachable failure log fires', async () => {
    // PROVEN-RED: on pre-#353 code this log line does not exist — the `review.timedOut`
    // branch recorded outcome=error but logged nothing (and the #352 catch was dead).
    const ws = mkWs();
    try {
      const logs: LogEntry[] = [];
      const timedOutSpawn: ClaudeSpawnFn = async () => ({ stdout: '', timedOut: true });
      const mgr = new DreamingManager({
        db: makeDb(),
        agentId: 'founder',
        workspaceDir: ws,
        globalCfg: { mode: 'auto' },
        spawnFn: timedOutSpawn,
        logger: mkLogger(logs),
      });

      const res = await mgr.dreamOnce(NOW);

      expect(res.outcome).toBe('error');
      const failLog = logs.find((l) => l.msg === NO_OUTPUT_LOG);
      expect(failLog).toBeDefined();
      expect(failLog!.data?.agentId).toBe('founder');
      expect(failLog!.data?.outcome).toBe('error');
    } finally {
      fs.rmSync(ws, { recursive: true });
    }
  });

  it('DR-2: a structured failure reason + stderr tail are surfaced in the log', async () => {
    const ws = mkWs();
    try {
      const logs: LogEntry[] = [];
      const spawn: ClaudeSpawnFn = async () => ({
        stdout: '',
        timedOut: true,
        failureReason: 'timeout',
        stderrTail: 'API Error: 429 overloaded_error',
      });
      const mgr = new DreamingManager({
        db: makeDb(),
        agentId: 'founder',
        workspaceDir: ws,
        globalCfg: { mode: 'auto' },
        spawnFn: spawn,
        logger: mkLogger(logs),
      });

      await mgr.dreamOnce(NOW);

      const failLog = logs.find((l) => l.msg === NO_OUTPUT_LOG);
      expect(failLog).toBeDefined();
      expect(failLog!.data?.failureReason).toBe('timeout');
      expect(String(failLog!.data?.stderrTail)).toContain('overloaded_error');
    } finally {
      fs.rmSync(ws, { recursive: true });
    }
  });

  it('DR-3: a spawn that THROWS is caught, audited as error, and its reason logged (never crashes)', async () => {
    const ws = mkWs();
    try {
      const logs: LogEntry[] = [];
      const throwingSpawn: ClaudeSpawnFn = async () => {
        throw new Error('ENOENT: claude binary missing');
      };
      const mgr = new DreamingManager({
        db: makeDb(),
        agentId: 'founder',
        workspaceDir: ws,
        globalCfg: { mode: 'auto' },
        spawnFn: throwingSpawn,
        logger: mkLogger(logs),
      });

      // Must not reject — dreaming must never wedge the daemon.
      const res = await mgr.dreamOnce(NOW);
      expect(res.outcome).toBe('error');

      // runDreamReviewer converts the throw into a timedOut result carrying the
      // reason, so the reachable branch logs it (the defensive contract-violation
      // catch stays a fallback, not the sole diagnostic).
      const failLog = logs.find((l) => l.msg === NO_OUTPUT_LOG);
      expect(failLog).toBeDefined();
      expect(String(failLog!.data?.failureReason)).toContain('spawn-throw');
    } finally {
      fs.rmSync(ws, { recursive: true });
    }
  });

  it('DR-4: makeClaudeSpawn captures stderr + a non-zero-exit reason (was discarded before)', async () => {
    // A fake claude that writes its real error to stderr and exits non-zero with
    // empty stdout — the exact shape that used to vanish into an opaque timedOut.
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakebin-'));
    const binPath = path.join(binDir, 'fake-claude.sh');
    fs.writeFileSync(binPath, '#!/bin/sh\ncat >/dev/null\necho "API Error: 429 overloaded_error" >&2\nexit 1\n');
    fs.chmodSync(binPath, 0o755);
    const prevBin = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = binPath;
    try {
      const spawn = makeClaudeSpawn('claude-haiku-4-5-20251001');
      const r = await spawn([], 'a prompt');
      expect(r.stdout).toBe('');
      expect(r.failureReason).toMatch(/^nonzero-exit:1$/);
      expect(String(r.stderrTail)).toContain('overloaded_error');
    } finally {
      if (prevBin === undefined) delete process.env.CLAUDE_BIN;
      else process.env.CLAUDE_BIN = prevBin;
      fs.rmSync(binDir, { recursive: true });
    }
  });

  it('DR-5: makeClaudeSpawn success path is unchanged (stdout returned, no failure reason)', async () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakebin-'));
    const binPath = path.join(binDir, 'fake-claude.sh');
    const envelope = JSON.stringify({ result: '{"summary":"ok","proposals":[]}', usage: {} });
    fs.writeFileSync(binPath, `#!/bin/sh\ncat >/dev/null\ncat <<'JSON'\n${envelope}\nJSON\n`);
    fs.chmodSync(binPath, 0o755);
    const prevBin = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = binPath;
    try {
      const spawn = makeClaudeSpawn('claude-haiku-4-5-20251001');
      const r = await spawn([], 'a prompt');
      expect(r.stdout).toContain('proposals');
      expect(r.failureReason).toBeUndefined();
      expect(r.timedOut).toBeFalsy();
    } finally {
      if (prevBin === undefined) delete process.env.CLAUDE_BIN;
      else process.env.CLAUDE_BIN = prevBin;
      fs.rmSync(binDir, { recursive: true });
    }
  });

  it('DR-6: a healthy reviewer run does NOT emit the failure log (no false positives)', async () => {
    const ws = mkWs();
    try {
      const logs: LogEntry[] = [];
      const goodSpawn: ClaudeSpawnFn = async () => ({
        stdout: JSON.stringify({ result: JSON.stringify({ summary: 's', proposals: [] }), usage: {} }),
      });
      const mgr = new DreamingManager({
        db: makeDb(),
        agentId: 'founder',
        workspaceDir: ws,
        globalCfg: { mode: 'auto' },
        spawnFn: goodSpawn,
        logger: mkLogger(logs),
      });

      const res = await mgr.dreamOnce(NOW);
      expect(res.outcome).toBe('no-changes');
      expect(logs.find((l) => l.msg === NO_OUTPUT_LOG)).toBeUndefined();
    } finally {
      fs.rmSync(ws, { recursive: true });
    }
  });
});

// Keep the shared import referenced so the suite documents the real seam.
void gatherTranscript;
