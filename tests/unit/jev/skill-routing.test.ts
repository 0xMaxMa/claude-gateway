import { recommendJevSkills, JevSkillCandidate, JevSkillRoutingOptions } from '../../../src/jev/skill-routing';
import { JevRequest, JevResult } from '../../../src/jev/types';

const skill = (id: string, extra: Partial<JevSkillCandidate> = {}): JevSkillCandidate => ({ id, name: id, description: `When to use ${id}`, ...extra });
const result = (request: JevRequest, scores: number[] = []): JevResult => ({
  requestId: 'fixture', requestedModel: 'jev', model: 'jev', usage: { input_tokens: 20, output_tokens: 1 },
  answers: Object.fromEntries(Object.keys(request.questions).map((id, i) => [id, { type: 'noul', noul: scores[i] ?? .8 }])),
});
function fixture(extra: Partial<JevSkillRoutingOptions> = {}) {
  const evaluate = jest.fn(async (request: JevRequest) => result(request));
  const options: JevSkillRoutingOptions = { enabled: true, task: 'Review the current patch', catalog: [skill('review'), skill('test')], evaluate, ...extra };
  return { options, evaluate };
}

describe('opt-in Jev skill recommendations', () => {
  it('preserves explicit/required/ongoing skills without evaluating them and excludes inaccessible optional skills', async () => {
    const f = fixture({
      catalog: [skill('explicit', { manualOnly: true }), skill('required'), skill('ongoing'), skill('off', { enabled: false }), skill('manual', { manualOnly: true }), skill('private', { accessible: false }), skill('review'), skill('test')],
      explicitIds: ['explicit'], requiredIds: ['required', 'explicit'], ongoingIds: ['ongoing'],
    });
    const answer = await recommendJevSkills(f.options);
    expect(answer).toMatchObject({ mode: 'recommended', preservedIds: ['explicit', 'required', 'ongoing'], recommendedIds: ['review', 'test'], evaluatedCount: 2, evaluations: 1 });
    expect(Object.keys(f.evaluate.mock.calls[0][0].questions)).toHaveLength(2);
    expect(JSON.stringify(f.evaluate.mock.calls)).not.toMatch(/explicit|required|ongoing|private|manual/);
  });
  it('does not send local IDs, paths or full bodies and maps recommendations back to stable IDs', async () => {
    const candidate = { ...skill('/local/skills/review/SKILL.md', { name: 'Code review' }), description: 'Review changes for defects', path: '/private/source', body: 'PRIVATE FULL CONTENT' };
    const f = fixture({ catalog: [candidate], context: 'แก้สองข้อจากงานรีวิวเดิม', task: 'ทำต่อเลย' });
    const answer = await recommendJevSkills(f.options);
    expect(answer.recommendedIds).toEqual(['/local/skills/review/SKILL.md']);
    const sent = JSON.stringify(f.evaluate.mock.calls[0][0]);
    expect(sent).toContain('แก้สองข้อจากงานรีวิวเดิม');
    expect(sent).not.toMatch(/\/local|\/private|PRIVATE FULL CONTENT/);
  });
  it('evaluates all candidates across batches, supports multiple recommendations, and keeps input ordering', async () => {
    const f = fixture({ catalog: Array.from({ length: 7 }, (_, i) => skill(`s${i}`)), batchSize: 3 });
    const answer = await recommendJevSkills(f.options);
    expect(answer.recommendedIds).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's6']);
    expect(answer.evaluatedCount).toBe(7);
    expect(f.evaluate.mock.calls.map(([request]) => Object.keys(request.questions).length)).toEqual([3, 3, 1]);
  });
  it('treats low probability as no optional recommendation, not provider failure', async () => {
    const f = fixture(); f.evaluate.mockImplementation(async request => result(request, [.1, .59]));
    expect(await recommendJevSkills(f.options)).toMatchObject({ mode: 'recommended', recommendedIds: [], reason: 'evaluated' });
  });
  it.each([{ enabled: false }, { nativeRoutingActive: true }])('does not double route or run without opt-in: %j', async extra => {
    const f = fixture(extra);
    expect((await recommendJevSkills(f.options)).mode).toBe('native');
    expect(f.evaluate).not.toHaveBeenCalled();
  });
  it('fails back before any calls if a later batch or total candidate budget exceeds its bounds', async () => {
    const f = fixture({ catalog: [skill('small'), skill('large', { description: 'x'.repeat(2000) })], batchSize: 1, maxInputBytes: 1000 });
    expect((await recommendJevSkills(f.options)).reason).toBe('oversized_input');
    expect(f.evaluate).not.toHaveBeenCalled();
    const g = fixture({ catalog: [skill('one'), skill('two'), skill('three')], batchSize: 1, maxBatches: 2 });
    expect((await recommendJevSkills(g.options)).reason).toBe('oversized_input');
    expect(g.evaluate).not.toHaveBeenCalled();
  });
  it('drops partial recommendations when a later batch fails', async () => {
    const f = fixture({ batchSize: 1, explicitIds: ['keep'], catalog: [skill('keep'), skill('one'), skill('two')] });
    f.evaluate.mockImplementationOnce(async request => result(request)).mockRejectedValueOnce(new Error('secret-provider-error'));
    const answer = await recommendJevSkills(f.options);
    expect(answer).toMatchObject({ mode: 'native', reason: 'evaluation_failed', preservedIds: ['keep'], recommendedIds: [], evaluatedCount: 1 });
    expect(JSON.stringify(answer)).not.toContain('secret-provider-error');
  });
  it.each([{}, { skill_0: { type: 'noul', noul: NaN }, skill_1: { type: 'noul', noul: .8 } }, { skill_0: { type: 'noul', noul: 1.1 }, skill_1: { type: 'noul', noul: .8 } }, { skill_0: { type: 'choice', noul: .9 }, skill_1: { type: 'noul', noul: .8 } }, { unknown: { type: 'noul', noul: .8 }, skill_1: { type: 'noul', noul: .8 } }])('rejects partial/invalid answers without recommending a subset: %j', async answers => {
    const f = fixture(); f.evaluate.mockImplementation(async request => ({ ...result(request), answers } as JevResult));
    expect(await recommendJevSkills(f.options)).toMatchObject({ mode: 'native', reason: 'invalid_response', recommendedIds: [] });
  });
  it('preserves required skill IDs for native resolution when the authorized catalog is stale', async () => {
    const f = fixture({ requiredIds: ['missing'] });
    expect(await recommendJevSkills(f.options)).toMatchObject({ mode: 'native', reason: 'catalog_changed', preservedIds: ['missing'] });
    expect(f.evaluate).not.toHaveBeenCalled();
  });
  it('rejects catalog version changes after inference before recommending anything', async () => {
    let version = 'v1'; const f = fixture({ catalogVersion: version, currentCatalogVersion: () => version });
    f.evaluate.mockImplementation(async request => { version = 'v2'; return result(request); });
    expect(await recommendJevSkills(f.options)).toMatchObject({ mode: 'native', reason: 'catalog_changed', recommendedIds: [] });
  });
  it('bounds a callback that ignores cancellation and never resolves', async () => {
    const f = fixture({ timeoutMs: 10 }); f.evaluate.mockImplementation(() => new Promise(() => {}));
    expect(await recommendJevSkills(f.options)).toMatchObject({ mode: 'native', reason: 'deadline_exceeded', recommendedIds: [] });
  });
  it('does not invoke the evaluator for a cancelled request', async () => {
    const controller = new AbortController(); controller.abort();
    const f = fixture({ signal: controller.signal });
    expect((await recommendJevSkills(f.options)).reason).toBe('cancelled');
    expect(f.evaluate).not.toHaveBeenCalled();
  });
  it('rejects duplicate stable identities and invalid bounds instead of changing routing silently', async () => {
    const f = fixture({ catalog: [skill('same'), skill('same')] });
    expect((await recommendJevSkills(f.options)).reason).toBe('invalid_input');
    expect(f.evaluate).not.toHaveBeenCalled();
    expect((await recommendJevSkills({ ...f.options, threshold: NaN })).reason).toBe('invalid_input');
  });
});
