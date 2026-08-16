import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HistoryDB } from '../../../src/history/db';
import { SkillLearningManager } from '../../../src/agent/skill-learning';
import { extractFrontmatter } from '../../../src/skills/parser';
import type { ClaudeSpawnFn } from '../../../src/agent/skill-learning/reviewer';
import type { SkillLearningConfig } from '../../../src/agent/skill-learning/types';

const NOW = 1_000_000;

function setup(cfg: SkillLearningConfig = {}, spawn?: ClaudeSpawnFn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-mgr-'));
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(path.join(ws, 'skills'), { recursive: true });
  const db = HistoryDB.forAgent(dir, `agent-${Math.random().toString(36).slice(2)}`);
  const mgr = new SkillLearningManager({
    db,
    agentId: 'agent-x',
    workspaceDir: ws,
    globalCfg: cfg,
    reviewSpawn: spawn,
    now: () => NOW,
  });
  return { db, ws, mgr, dir };
}

function seedTranscript(db: HistoryDB, sessionId: string): void {
  db.insertMessage({ chatId: `telegram-${sessionId}`, sessionId, source: 'telegram', role: 'user', content: 'deploy the thing', ts: NOW });
  db.insertMessage({ chatId: `telegram-${sessionId}`, sessionId, source: 'telegram', role: 'assistant', content: 'done', ts: NOW });
}

const createEnvelope = (name: string): ClaudeSpawnFn => async () => ({
  stdout: JSON.stringify({
    type: 'result',
    result: JSON.stringify({ action: 'create', name, desc: 'a reusable flow', body: 'do the steps' }),
    usage: { input_tokens: 120, output_tokens: 30 },
  }),
});

describe('SkillLearningManager — telemetry capture', () => {
  it('onTurnStart→onToolUse→onTurnEnd persists a turn_metrics row', () => {
    const { db, mgr, dir } = setup();
    mgr.onTurnStart('chat1', 'sess1', '/deploy prod', []);
    mgr.onToolUse('chat1', 'id-1');
    mgr.onToolUse('chat1', 'id-2');
    mgr.onTokenUsage('chat1', 500, 200);
    mgr.onTurnEnd('chat1', 'sess1');
    const rows = db.getTurnMetricsForSession('sess1');
    expect(rows).toHaveLength(1);
    expect(rows[0].toolCalls).toBe(2);
    expect(rows[0].intentHash).toBe('cmd:deploy');
    expect(rows[0].enabled).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('dedups repeated tool_use ids (cumulative snapshots)', () => {
    const { db, mgr, dir } = setup();
    mgr.onTurnStart('chat1', 'sess1', 'hi', []);
    mgr.onToolUse('chat1', 'id-1');
    mgr.onToolUse('chat1', 'id-1'); // duplicate snapshot
    mgr.onToolUse('chat1', 'id-2');
    mgr.onTurnEnd('chat1', 'sess1');
    expect(db.getTurnMetricsForSession('sess1')[0].toolCalls).toBe(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('captures telemetry even when disabled (baseline cohort enabled=0)', () => {
    const { db, mgr, dir } = setup({ enabled: false });
    mgr.onTurnStart('chat1', 'sess1', 'hello world task', []);
    mgr.onToolUse('chat1', 'id-1');
    mgr.onTurnEnd('chat1', 'sess1');
    const rows = db.getTurnMetricsForSession('sess1');
    expect(rows).toHaveLength(1);
    expect(rows[0].enabled).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('records skills-loaded and bumps skill_stats usage', () => {
    const { db, mgr, dir } = setup();
    mgr.onTurnStart('chat1', 'sess1', 'x', ['my-skill']);
    mgr.onTurnEnd('chat1', 'sess1');
    expect(db.getSkillStat('my-skill')!.timesLoaded).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('SkillLearningManager — review path', () => {
  it('a qualifying session writes a learned skill (origin:auto) live', async () => {
    const { db, ws, mgr, dir } = setup({ minToolCalls: 3 }, createEnvelope('deploy-flow'));
    seedTranscript(db, 'sess1');
    mgr.onTurnStart('chat1', 'sess1', 'deploy the thing', []);
    for (let i = 0; i < 4; i++) mgr.onToolUse('chat1', `id-${i}`);
    mgr.onTurnEnd('chat1', 'sess1');

    await mgr.runReviewNow('chat1', 'sess1');

    const file = path.join(ws, 'skills', 'deploy-flow', 'SKILL.md');
    expect(fs.existsSync(file)).toBe(true);
    expect(extractFrontmatter(fs.readFileSync(file, 'utf-8'))!.frontmatter['origin']).toBe('auto');
    expect(db.getSkillStat('deploy-flow')!.origin).toBe('auto');
    expect(db.countReviewRunsSince(0)).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a non-qualifying session (below minToolCalls, no recovery) does NOT review', async () => {
    const spawn = jest.fn(createEnvelope('should-not-exist'));
    const { db, ws, mgr, dir } = setup({ minToolCalls: 5 }, spawn as unknown as ClaudeSpawnFn);
    seedTranscript(db, 'sess1');
    mgr.onTurnStart('chat1', 'sess1', 'hi', []);
    mgr.onToolUse('chat1', 'id-1');
    mgr.onTurnEnd('chat1', 'sess1');
    await mgr.runReviewNow('chat1', 'sess1');
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(ws, 'skills', 'should-not-exist'))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('PROVENANCE e2e: reviewer proposes edit on a user skill → refused, file unchanged', async () => {
    const editEnvelope: ClaudeSpawnFn = async () => ({
      stdout: JSON.stringify({
        type: 'result',
        result: JSON.stringify({ action: 'edit', targetSkill: 'handcraft', desc: 'hijacked', body: 'malicious' }),
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    });
    const { db, ws, mgr, dir } = setup({ minToolCalls: 1 }, editEnvelope);
    // pre-seed a hand-authored (user) skill
    const skillDir = path.join(ws, 'skills', 'handcraft');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: handcraft\ndescription: "human made"\n---\noriginal body\n`, 'utf-8');
    seedTranscript(db, 'sess1');

    mgr.onTurnStart('chat1', 'sess1', 'x', []);
    for (let i = 0; i < 3; i++) mgr.onToolUse('chat1', `id-${i}`);
    mgr.onTurnEnd('chat1', 'sess1');
    await mgr.runReviewNow('chat1', 'sess1');

    expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8')).toContain('original body');
    // a review run is still logged (as error/no-write), but no skill_stats auto row for handcraft
    expect(db.getSkillStat('handcraft')).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('mode:propose routes the write to the .pending queue, not live', async () => {
    const { db, ws, mgr, dir } = setup({ minToolCalls: 1, mode: 'propose' }, createEnvelope('queued-flow'));
    seedTranscript(db, 'sess1');
    mgr.onTurnStart('chat1', 'sess1', 'x', []);
    for (let i = 0; i < 2; i++) mgr.onToolUse('chat1', `id-${i}`);
    mgr.onTurnEnd('chat1', 'sess1');
    await mgr.runReviewNow('chat1', 'sess1');
    expect(fs.existsSync(path.join(ws, 'skills', '.pending', 'queued-flow', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(ws, 'skills', 'queued-flow', 'SKILL.md'))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
