import { runReviewer, coerceProposal, type ClaudeSpawnFn } from '../../../src/agent/skill-learning/reviewer';
import { SKILL_LEARNING_DEFAULTS } from '../../../src/agent/skill-learning/config';

const cfg = SKILL_LEARNING_DEFAULTS;
const input = { transcript: 'user: do X\nassistant: did X', existingSkills: [] };

/** A spawn stub that returns a fixed claude `--output-format json` envelope. */
function envelopeSpawn(result: string, tokens = 100): ClaudeSpawnFn {
  return async () => ({ stdout: JSON.stringify({ type: 'result', result, usage: { input_tokens: tokens, output_tokens: 0 } }) });
}

describe('coerceProposal', () => {
  it('passes through a valid create', () => {
    expect(coerceProposal({ action: 'create', name: 'foo', desc: 'd', body: 'b' })).toEqual({
      action: 'create',
      name: 'foo',
      desc: 'd',
      body: 'b',
      targetSkill: undefined,
      rationale: undefined,
    });
  });
  it('coerces an unknown action to none', () => {
    expect(coerceProposal({ action: 'delete' })).toEqual({ action: 'none' });
  });
  it('coerces non-objects to none', () => {
    expect(coerceProposal(null)).toEqual({ action: 'none' });
    expect(coerceProposal('nope')).toEqual({ action: 'none' });
  });
});

describe('runReviewer', () => {
  it('parses a create proposal out of the json envelope and reports tokens', async () => {
    const spawn = envelopeSpawn(JSON.stringify({ action: 'create', name: 'deploy-flow', desc: 'd', body: 'b' }), 250);
    const r = await runReviewer(input, cfg, spawn);
    expect(r.proposal.action).toBe('create');
    expect(r.proposal.name).toBe('deploy-flow');
    expect(r.tokensSpent).toBe(250);
  });

  it('extracts JSON even when the model wraps it in prose', async () => {
    const spawn = envelopeSpawn('Sure! Here you go:\n{"action":"none"}\nThanks');
    const r = await runReviewer(input, cfg, spawn);
    expect(r.proposal.action).toBe('none');
  });

  it('malformed model output → none (never writes on garbage)', async () => {
    const spawn = envelopeSpawn('not json at all');
    const r = await runReviewer(input, cfg, spawn);
    expect(r.proposal).toEqual({ action: 'none' });
  });

  it('timeout → none', async () => {
    const spawn: ClaudeSpawnFn = async () => ({ stdout: '', timedOut: true });
    const r = await runReviewer(input, cfg, spawn);
    expect(r.proposal).toEqual({ action: 'none' });
    expect(r.timedOut).toBe(true);
  });

  it('a throwing spawn never rejects', async () => {
    const spawn: ClaudeSpawnFn = async () => {
      throw new Error('boom');
    };
    await expect(runReviewer(input, cfg, spawn)).resolves.toEqual({
      proposal: { action: 'none' },
      tokensSpent: 0,
      timedOut: true,
    });
  });
});
