import { JevService } from '../../../src/jev/service';
import { JevConfig, JevRequest, JevResult } from '../../../src/jev/types';
import { imageDimensions, validateJevRequest, validateJevResponse } from '../../../src/jev/validation';
import { buildRefineStep, buildVisionStep, readRefineStep, readVisionStep, refineCrop, VisionStepInput } from '../../../src/automation/jev-vision-step';

const png = (width: number, height: number) => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const chunk = (type: string, data: Buffer) => Buffer.concat([Buffer.from([0, 0, 0, data.length]), Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', Buffer.alloc(0))]);
};
const REF = 'screen-0001';
const imageRequest = (width = 1280, height = 800): JevRequest => ({
  state: { screen: REF },
  questions: { visible: { type: 'noul', instructions: 'Is Save visible in `screen`?' }, target: { type: 'box', instructions: 'the Save button in `screen`' } },
  assets: { [REF]: { type: 'image', format: 'png', data_base64: png(width, height).toString('base64') } },
});
const enabled: JevConfig = { enabled: true, provider: 'typesafe', model: 'jev-1.14.0', images: { enabled: true } };
const context = { principalId: 'agent:a', consumer: 'test' };

describe('Jev image input', () => {
  it('rejects images and Box unless images are enabled', () => {
    expect(() => validateJevRequest(imageRequest(), { ...enabled, images: undefined })).toThrow('not enabled');
    const { assets: _, ...boxOnly } = imageRequest();
    expect(() => validateJevRequest(boxOnly, { ...enabled, images: undefined })).toThrow();
  });
  it('sends assets with the image header only for image requests', async () => {
    const answers = { visible: { type: 'noul', noul: 0.9 }, target: { type: 'box', box: { top: 0.2, bottom: 0.3, left: 0.1, right: 0.2 }, confidence: 0.8 } };
    const fetcher = jest.fn(async (_url: unknown, init: any) => new Response(JSON.stringify(JSON.parse(init.body).assets ? { model: 'jev-1.14.0', answers, usage: { input_tokens: 3000, output_tokens: 50 } } : { model: 'jev-1.14.0', answers: { urgent: { type: 'noul', noul: 0.1 } }, usage: { input_tokens: 10, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } }));
    const service = new JevService({ getConfig: () => enabled, resolveConnection: async () => ({ baseUrl: 'https://provider.example', apiKey: 'k' }), fetch: fetcher as any });
    const result = await service.evaluate(imageRequest(), context);
    expect(result.answers.target).toEqual(answers.target);
    const [, init] = fetcher.mock.calls[0] as any[];
    expect(init.headers['TypeSafe-Danger-Zone-Images']).toBe('true');
    expect(Object.keys(JSON.parse(init.body).assets)).toEqual([REF]);
    await service.evaluate({ state: 'x', questions: { urgent: { type: 'noul', instructions: 'Urgent?' } } }, context);
    const [, plain] = fetcher.mock.calls[1] as any[];
    expect(plain.headers['TypeSafe-Danger-Zone-Images']).toBeUndefined();
    expect(JSON.parse(plain.body).assets).toBeUndefined();
  });
  it('rejects unreferenced assets and images outside the documented size range', () => {
    expect(() => validateJevRequest({ ...imageRequest(), state: { screen: 'other' } }, enabled)).toThrow('referenced');
    expect(() => validateJevRequest(imageRequest(1600, 800), enabled)).toThrow('dimensions');
    expect(() => validateJevRequest(imageRequest(1280, 200), enabled)).toThrow('dimensions');
    expect(imageDimensions(png(1280, 800), 'png')).toEqual({ width: 1280, height: 800 });
    expect(imageDimensions(png(1280, 800), 'jpg')).toBeUndefined();
  });
  it('validates Box answers', () => {
    const request = imageRequest();
    const ok = { model: 'jev-1.14.0', answers: { visible: { type: 'noul', noul: 0.9 }, target: { type: 'box', box: { top: 0.2, bottom: 0.3, left: 0.1, right: 0.2 }, confidence: 0.8 } }, usage: { input_tokens: 1, output_tokens: 1 } };
    expect(validateJevResponse(ok, request, 'jev-1.14.0', 'r').answers.target).toEqual(ok.answers.target);
    const inverted = structuredClone(ok); inverted.answers.target.box.left = 0.5;
    expect(() => validateJevResponse(inverted, request, 'jev-1.14.0', 'r')).toThrow();
  });
  // Observed from jev-1.14.0: a nine-option choice named E1 at 0.16 while E2 was 0.17.
  it('accepts a rounded choice one hundredth below the maximum, but not further', () => {
    const request: JevRequest = { state: 's', questions: { pick: { type: 'choice', instructions: 'Which?', criteria: { A: 'a', B: 'b', C: 'c' } } } };
    const answer = (p: Record<string, number>) => ({ model: 'jev-1.14.0', answers: { pick: { type: 'choice', choice: 'A', confidence: 0.1, probabilities: p } }, usage: { input_tokens: 1, output_tokens: 1 } });
    expect(validateJevResponse(answer({ A: 0.33, B: 0.34, C: 0.33 }), request, 'jev-1.14.0', 'r').answers.pick).toMatchObject({ choice: 'A' });
    expect(() => validateJevResponse(answer({ A: 0.32, B: 0.35, C: 0.33 }), request, 'jev-1.14.0', 'r')).toThrow();
  });
});

describe('image-first vision step', () => {
  const screenshot = { data: png(1280, 800).toString('base64'), format: 'png' as const, width: 1280, height: 800 };
  const input = (over: Partial<VisionStepInput> = {}): VisionStepInput => ({ variant: 'image', goal: 'Save the document', history: [], screenshot, ...over });
  const choice = (choice: string, p: Record<string, number>) => ({ type: 'choice' as const, choice, confidence: p[choice], probabilities: p });
  const result = (answers: Record<string, unknown>): JevResult => ({ requestId: 'r', requestedModel: 'm', model: 'm', usage: { input_tokens: 1, output_tokens: 1 }, answers: {
    done: { type: 'noul', noul: 0 }, op: choice('CLICK', { CLICK: 1 }), impact: choice('ROUTINE', { ROUTINE: 1, HIGH_IMPACT: 0 }), visible: { type: 'noul', noul: 0.9 },
    target: { type: 'box', box: { top: 0.2, bottom: 0.3, left: 0.1, right: 0.2 }, confidence: 0.8 }, ...answers } as JevResult['answers'] });

  it('asks one request with the screenshot, Box and visibility questions', () => {
    const request = buildVisionStep(input());
    expect(Object.keys(request.questions)).toEqual(expect.arrayContaining(['done', 'impact', 'op', 'target', 'visible']));
    expect(validateJevRequest(request, enabled).assets).toBeDefined();
    expect(buildVisionStep(input({ variant: 'text', screenshot: undefined })).assets).toBeUndefined();
  });
  it('clicks the Box center in screen pixels', () => {
    expect(readVisionStep(input(), result({}))).toEqual({ kind: 'click', at: { x: 192, y: 200 }, source: 'box' });
  });
  it('scrolls instead of trusting a Box whose target is not visible', () => {
    expect(readVisionStep(input(), result({ visible: { type: 'noul', noul: 0.1 } }))).toEqual({ kind: 'scroll', direction: 'down', amount: 'SCREEN' });
  });
  it('reads the scroll direction, amount and area in one answer', () => {
    expect(readVisionStep(input(), result({ op: choice('SCROLL', { SCROLL: 1 }), scroll: choice('UP', { DOWN: 0.1, UP: 0.9 }), amount: choice('FAR', { SMALL: 0, SCREEN: 0.1, FAR: 0.9 }), area: { type: 'box', box: { top: 0, bottom: 0.5, left: 0.5, right: 1 }, confidence: 0.9 } })))
      .toEqual({ kind: 'scroll', direction: 'up', amount: 'FAR', at: { x: 960, y: 200 } });
  });
  it('reads a key and its repeat count', () => {
    expect(readVisionStep(input(), result({ op: choice('KEY', { KEY: 1 }), key: choice('BACKSPACE', { BACKSPACE: 1 }), count: choice('3', { '3': 1 }) }))).toEqual({ kind: 'key', key: 'BACKSPACE', count: 3 });
  });
  it('navigates only to an address the goal spells out, and goes back', () => {
    const goal = input({ goal: 'Go to http://lab.test/docs' });
    const request = buildVisionStep(goal);
    expect((request.questions.url as any).criteria).toEqual({ NONE: 'No listed address', 'URL:0': JSON.stringify({ url: 'http://lab.test/docs' }) });
    expect(readVisionStep(goal, result({ op: choice('NAVIGATE', { NAVIGATE: 1 }), url: choice('URL:0', { NONE: 0, 'URL:0': 1 }) }))).toEqual({ kind: 'navigate', url: 'http://lab.test/docs' });
    expect(readVisionStep(input(), result({ op: choice('NAVIGATE', { NAVIGATE: 1 }) }))).toEqual({ kind: 'give_up', reason: 'NO_URL' });
    expect(readVisionStep(input(), result({ op: choice('BACK', { BACK: 1 }) }))).toEqual({ kind: 'back' });
  });
  it('returns a high-impact step unexecuted with its resolved target', () => {
    expect(readVisionStep(input(), result({ impact: choice('HIGH_IMPACT', { ROUTINE: 0.2, HIGH_IMPACT: 0.8 }) }))).toEqual({ kind: 'confirm', action: { kind: 'click', at: { x: 192, y: 200 }, source: 'box' } });
  });
  it('prefers a confident listed element in the hybrid variant', () => {
    const hybrid = input({ variant: 'hybrid', elements: [{ id: 'E1', role: 'button', label: 'Save' }] });
    expect(readVisionStep(hybrid, result({ element: choice('E1', { NONE: 0.1, E1: 0.9 }) }))).toEqual({ kind: 'click', at: { elementId: 'E1' }, source: 'element' });
    expect(readVisionStep(hybrid, result({ element: choice('NONE', { NONE: 0.9, E1: 0.1 }) }))).toMatchObject({ source: 'box' });
  });
  it('types only text quoted in the goal', () => {
    const typing = input({ goal: 'Search for "wireless mouse"' });
    const request = buildVisionStep(typing);
    const [id] = Object.entries((request.questions.text as any).criteria).find(([, c]) => String(c).includes('wireless mouse'))!;
    expect(readVisionStep(typing, result({ op: choice('TYPE', { TYPE: 1 }), text: choice(id, { NONE: 0, [id]: 1 }) }))).toMatchObject({ kind: 'type', text: 'wireless mouse' });
  });
  it('maps a refined Box from the crop back to the screen', () => {
    const crop = refineCrop({ x: 10, y: 790 }, { width: 1280, height: 800 });
    expect(crop).toEqual({ x: 0, y: 400, width: 400, height: 400 });
    expect(Object.keys(buildRefineStep('g', [], { ...screenshot, width: 400, height: 400 }).assets!)).toHaveLength(1);
    expect(readRefineStep(result({ target: { type: 'box', box: { top: 0.5, bottom: 0.6, left: 0.1, right: 0.2 }, confidence: 0.9 } }), crop)).toEqual({ x: 60, y: 620 });
    expect(readRefineStep(result({ visible: { type: 'noul', noul: 0.2 } }), crop)).toBeUndefined();
  });
});
