/**
 * Skill-learning e2e (opt-in; excluded from the default jest run — see
 * jest.config testPathIgnorePatterns). Runs the full closed loop against a
 * SCRIPTED mock reviewer (no real model): qualifying turn → trigger → reviewer
 * proposal → writer writes SKILL.md → loadSkills shows it LIVE (hot-reload
 * discovery, AC#4) → a subsequent turn invoking it bumps skill_stats and the
 * rollup reflects adoption. Plus the provenance-guard e2e (AC#5).
 *
 * Run: npm run test:e2e
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HistoryDB } from '../../src/history/db';
import { SkillLearningManager } from '../../src/agent/skill-learning';
import { loadSkills } from '../../src/skills/loader';
import type { ClaudeSpawnFn } from '../../src/agent/skill-learning/reviewer';

const NOW = 2_000_000;

function scriptedReviewer(proposalJson: object): ClaudeSpawnFn {
  return async () => ({
    stdout: JSON.stringify({
      type: 'result',
      result: JSON.stringify(proposalJson),
      usage: { input_tokens: 100, output_tokens: 40 },
    }),
  });
}

function setup(spawn: ClaudeSpawnFn, cfg = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-e2e-'));
  const ws = path.join(dir, 'workspace');
  fs.mkdirSync(path.join(ws, 'skills'), { recursive: true });
  const db = HistoryDB.forAgent(dir, `agent-${Math.random().toString(36).slice(2)}`);
  const mgr = new SkillLearningManager({
    db, agentId: 'e2e-agent', workspaceDir: ws, globalCfg: { minToolCalls: 3, ...cfg }, reviewSpawn: spawn, now: () => NOW,
  });
  db.insertMessage({ chatId: `telegram-sess1`, sessionId: 'sess1', source: 'telegram', role: 'user', content: 'deploy the app to prod', ts: NOW });
  db.insertMessage({ chatId: `telegram-sess1`, sessionId: 'sess1', source: 'telegram', role: 'assistant', content: 'deployed', ts: NOW });
  return { dir, ws, db, mgr };
}

async function qualifyingTurn(mgr: SkillLearningManager, msg = 'deploy the app to prod'): Promise<void> {
  mgr.onTurnStart('chat1', 'sess1', msg, []);
  for (let i = 0; i < 4; i++) mgr.onToolUse('chat1', `id-${i}`);
  mgr.onTurnEnd('chat1', 'sess1');
  await mgr.runReviewNow('chat1', 'sess1');
}

describe('skill-learning e2e — full closed loop', () => {
  it('auto mode: learns a skill that is LIVE on the next loadSkills (hot-reload), and reuse is measured', async () => {
    const { dir, ws, db, mgr } = setup(scriptedReviewer({ action: 'create', name: 'deploy-flow', desc: 'deploy the app', body: '1. build\n2. ship' }));

    await qualifyingTurn(mgr);

    // Written to the workspace skills dir with origin:auto
    const file = path.join(ws, 'skills', 'deploy-flow', 'SKILL.md');
    expect(fs.existsSync(file)).toBe(true);

    // LIVE on the next load — no restart needed (AC#4)
    const registry = loadSkills({ workspaceDir: ws });
    expect(registry.skills.has('deploy-flow')).toBe(true);
    expect(registry.skills.get('deploy-flow')!.description).toBe('deploy the app');

    // A subsequent turn that invokes the learned skill bumps its usage
    mgr.onTurnStart('chat1', 'sess1', '/deploy-flow', ['deploy-flow']);
    mgr.onTurnEnd('chat1', 'sess1');
    expect(db.getSkillStat('deploy-flow')!.timesLoaded).toBe(1);

    // The rollup reflects the adoption funnel + net-token ledger
    const rollup = mgr.rollup();
    expect(rollup.adoption.autoSkills).toBe(1);
    expect(rollup.netTokens.spentReviewing).toBe(140);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('provenance guard e2e: a proposed edit of a hand-authored skill is refused, file unchanged', async () => {
    const { dir, ws } = setup(scriptedReviewer({ action: 'edit', targetSkill: 'handmade', desc: 'x', body: 'overwritten' }));
    const skillDir = path.join(ws, 'skills', 'handmade');
    fs.mkdirSync(skillDir, { recursive: true });
    const original = `---\nname: handmade\ndescription: "human authored"\n---\nprecious body\n`;
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), original, 'utf-8');

    // rebuild a manager pointing at the same workspace with a fresh db but the seeded skill
    const db = HistoryDB.forAgent(dir + '-2', 'e2e-agent-2');
    db.insertMessage({ chatId: 'telegram-sess1', sessionId: 'sess1', source: 'telegram', role: 'user', content: 'x', ts: NOW });
    const mgr = new SkillLearningManager({ db, agentId: 'e2e-2', workspaceDir: ws, globalCfg: { minToolCalls: 1 }, reviewSpawn: scriptedReviewer({ action: 'edit', targetSkill: 'handmade', desc: 'x', body: 'overwritten' }), now: () => NOW });

    await qualifyingTurn(mgr, 'x');

    expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8')).toBe(original);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dir + '-2', { recursive: true, force: true });
  });
});
