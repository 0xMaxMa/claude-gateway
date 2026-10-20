import { JevService } from '../../../src/jev/service';
import { JevConfig, JevRequest, JevResult } from '../../../src/jev/types';
import { imageDimensions, validateJevConfig, validateJevRequest, validateJevResponse } from '../../../src/jev/validation';
import { buildRefineStep, buildRepeatCheck, buildVisionStep, readRefineStep, readVisionStep, refineCrop, repeatNeeded, SCROLL_AMOUNTS, VisionStepInput } from '../../../src/automation/jev-vision-step';
import { ScreenImage, boxCenter } from '../../../src/automation/vision-image';
import sharp from 'sharp';

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
  it('sends image requests to the pinned image model and text requests to the configured model', async () => {
    const answers = { visible: { type: 'noul', noul: 0.9 }, target: { type: 'box', box: { top: 0.2, bottom: 0.3, left: 0.1, right: 0.2 }, confidence: 0.8 } };
    const models: string[] = [];
    const fetcher = jest.fn(async (_url: unknown, init: any) => { const body = JSON.parse(init.body); models.push(body.model); return new Response(JSON.stringify(body.assets ? { model: body.model, answers, usage: { input_tokens: 1, output_tokens: 1 } } : { model: body.model, answers: { urgent: { type: 'noul', noul: 0.1 } }, usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } }); });
    const latest: JevConfig = { ...enabled, model: 'jev-latest' };
    const onEvaluation = jest.fn();
    const service = new JevService({ getConfig: () => latest, resolveConnection: async () => ({ baseUrl: 'https://provider.example', apiKey: 'k' }), fetch: fetcher as any, onEvaluation });
    await service.evaluate(imageRequest(), context);
    await service.evaluate({ state: 'x', questions: { urgent: { type: 'noul', instructions: 'Urgent?' } } }, context);
    latest.images = { enabled: true, model: 'jev-preview' };
    await service.evaluate(imageRequest(), context);
    expect(models).toEqual(['jev-1.14.0', 'jev-latest', 'jev-preview']);
    expect(onEvaluation.mock.calls.map(c => c[0].requestedModel)).toEqual(models);
  });
  it('validates the image model setting', () => {
    expect(() => validateJevConfig({ ...enabled, images: { enabled: true, model: '' } })).toThrow('image configuration');
    expect(() => validateJevConfig({ ...enabled, images: { enabled: true, model: 'jev-1.14.0' } })).not.toThrow();
  });
  it('validates Box answers', () => {
    const request = imageRequest();
    const ok = { model: 'jev-1.14.0', answers: { visible: { type: 'noul', noul: 0.9 }, target: { type: 'box', box: { top: 0.2, bottom: 0.3, left: 0.1, right: 0.2 }, confidence: 0.8 } }, usage: { input_tokens: 1, output_tokens: 1 } };
    expect(validateJevResponse(ok, request, 'jev-1.14.0', 'r').answers.target).toEqual(ok.answers.target);
    const inverted = structuredClone(ok); inverted.answers.target.box.left = 0.5;
    expect(() => validateJevResponse(inverted, request, 'jev-1.14.0', 'r')).toThrow();
    // jev-1.14.0 rounds a tiny target's sides together: a zero-width box is a point, not a malformed answer.
    const point = structuredClone(ok); point.answers.target.box.right = point.answers.target.box.left;
    expect(validateJevResponse(point, request, 'jev-1.14.0', 'r').answers.target).toMatchObject({ box: { left: 0.1, right: 0.1 } });
  });
  // Observed from jev-1.14.0: a nine-option choice named E1 at 0.16 while E2 was 0.17.
  it('accepts a rounded choice one hundredth below the maximum, but not further', () => {
    const request: JevRequest = { state: 's', questions: { pick: { type: 'choice', instructions: 'Which?', criteria: { A: 'a', B: 'b', C: 'c' } } } };
    const answer = (p: Record<string, number>) => ({ model: 'jev-1.14.0', answers: { pick: { type: 'choice', choice: 'A', confidence: 0.1, probabilities: p } }, usage: { input_tokens: 1, output_tokens: 1 } });
    expect(validateJevResponse(answer({ A: 0.33, B: 0.34, C: 0.33 }), request, 'jev-1.14.0', 'r').answers.pick).toMatchObject({ choice: 'A' });
    expect(() => validateJevResponse(answer({ A: 0.32, B: 0.35, C: 0.33 }), request, 'jev-1.14.0', 'r')).toThrow();
  });
});

describe('screenshots prepared for Jev', () => {
  const capture = (width: number, height: number, format: 'png' | 'jpeg' = 'png') => sharp({ create: { width, height, channels: 3, background: '#fff' } })[format]().toBuffer();
  it('scales a Retina capture into the side limit and maps a box back to the coordinate space', async () => {
    const screen = await ScreenImage.open(await capture(2880, 1800), { width: 1440, height: 900 });
    const image = await screen.render();
    expect([image.width, image.height]).toEqual([1568, 980]);
    expect(validateJevRequest(buildVisionStep({ goal: 'g', history: [], screen: image, point: true }), enabled).assets).toBeDefined();
    const center = boxCenter(image, { top: 0.5, bottom: 0.5, left: 0.25, right: 0.25 });
    expect(center.x).toBeCloseTo(360); expect(center.y).toBeCloseTo(450);
  });
  it('pads a small capture to the minimum side without moving its origin', async () => {
    const image = await (await ScreenImage.open(await capture(200, 120, 'jpeg'))).render();
    expect([image.width, image.height]).toEqual([280, 280]);
    expect(boxCenter(image, { top: 0, bottom: 0.2, left: 0, right: 0.2 })).toEqual({ x: 28, y: 28 });
  });
  it('renders a crop in its own pixels with its origin in the coordinate space', async () => {
    const screen = await ScreenImage.open(await capture(1280, 800), { width: 1280, height: 800 });
    const crop = await screen.render({ crop: refineCrop({ x: 1270, y: 10 }, { width: 1280, height: 800 }) });
    expect(crop.origin).toEqual({ x: 880, y: 0 });
    expect(boxCenter(crop, { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 })).toEqual({ x: 1080, y: 200 });
  });
  it('paints masked rectangles before marks or crops can show them', async () => {
    const screen = await ScreenImage.open(await capture(1280, 800), { width: 1280, height: 800 }, [{ x: 100, y: 100, width: 200, height: 50 }]);
    for (const image of [await screen.render({ marks: [{ id: '1', rect: { x: 400, y: 400, width: 50, height: 20 } }] }), await screen.render({ crop: { x: 0, y: 0, width: 400, height: 400 } })]) {
      const raw = Buffer.from(image.data, 'base64'), unit = 1 / image.unitsPerPixel;
      const at = await sharp(raw).extract({ left: Math.round((200 - image.origin.x) * unit), top: Math.round((125 - image.origin.y) * unit), width: 1, height: 1 }).raw().toBuffer();
      expect([...at]).toEqual([0, 0, 0]);
    }
  });
});

describe('image-first vision step', () => {
  // A PNG header is enough for request validation; the step module never decodes it.
  const screen = { data: png(1280, 800).toString('base64'), format: 'png' as unknown as 'jpg', width: 1280, height: 800, origin: { x: 0, y: 0 }, unitsPerPixel: 1 };
  const input = (over: Partial<VisionStepInput> = {}): VisionStepInput => ({ goal: 'Save the document', history: [], screen, point: true, ...over });
  const choice = (choice: string, p: Record<string, number>) => ({ type: 'choice' as const, choice, confidence: p[choice], probabilities: p });
  const box = { top: 0.2, bottom: 0.3, left: 0.1, right: 0.2 };
  const result = (answers: Record<string, unknown>): JevResult => ({ requestId: 'r', requestedModel: 'm', model: 'm', usage: { input_tokens: 1, output_tokens: 1 }, answers: {
    done: { type: 'noul', noul: 0 }, op: choice('CLICK', { CLICK: 1 }), visible: { type: 'noul', noul: 0.9 },
    target: { type: 'box', box, confidence: 0.8 }, ...answers } as JevResult['answers'] });

  it('asks one request with the screenshot and every argument, but not impact: the loop judges the resolved action', () => {
    const request = buildVisionStep(input());
    expect(Object.keys(request.questions)).toEqual(expect.arrayContaining(['done', 'op', 'target', 'visible', 'area', 'key', 'count', 'scroll', 'amount']));
    expect(request.questions).not.toHaveProperty('impact');
    expect(Object.keys(request.questions.op.type === 'choice' ? request.questions.op.criteria : {})).toEqual(['CLICK', 'TYPE', 'KEY', 'SCROLL', 'DONE', 'GIVE_UP']);
    expect(validateJevRequest(request, enabled).assets).toBeDefined();
    expect(Object.keys(buildVisionStep(input({ point: false })).questions)).not.toContain('target');
  });
  it('offers no "a little" scroll amount', () => {
    expect(Object.keys(SCROLL_AMOUNTS)).toEqual(['SCREEN', 'FAR']);
    expect(readVisionStep(input(), result({ op: choice('SCROLL', { SCROLL: 1 }), scroll: choice('UP', { DOWN: 0.1, UP: 0.9 }), amount: choice('FAR', { SCREEN: 0.1, FAR: 0.9 }), area: { type: 'box', box, confidence: 0.9 } })))
      .toEqual({ kind: 'scroll', direction: 'up', amount: 'FAR', area: box });
  });
  it('judges done from previous steps as well as the screen', () => {
    const done = buildVisionStep(input({ history: ['clicked "Save" (AXButton)'] })).questions.done;
    expect(done).toMatchObject({ type: 'noul', criteria: { true: expect.stringContaining('previous_steps') } });
    expect(readVisionStep(input(), result({ done: { type: 'noul', noul: 0.7 } }))).toEqual({ kind: 'done' });
  });
  it('locates a Box target only when the Noul agrees it is visible', () => {
    expect(readVisionStep(input(), result({}))).toEqual({ kind: 'click', target: { box } });
    expect(readVisionStep(input(), result({ visible: { type: 'noul', noul: 0.1 } }))).toEqual({ kind: 'scroll', direction: 'down', amount: 'SCREEN' });
    expect(readVisionStep(input(), result({ target: { type: 'box', box, confidence: 0.1 } }))).toEqual({ kind: 'give_up', reason: 'LOW_CONFIDENCE' });
  });
  it('reads a key and its repeat count', () => {
    expect(readVisionStep(input(), result({ op: choice('KEY', { KEY: 1 }), key: choice('BACKSPACE', { BACKSPACE: 1 }), count: choice('3', { '3': 1 }) }))).toEqual({ kind: 'key', key: 'BACKSPACE', count: 3 });
  });
  it('prefers a confident marked control', () => {
    const marked = input({ elements: [{ id: '1', role: 'AXButton', label: 'Save' }] });
    expect(readVisionStep(marked, result({ element: choice('1', { NONE: 0.1, '1': 0.9 }) }))).toEqual({ kind: 'click', target: { elementId: '1' } });
    expect(readVisionStep(marked, result({ element: choice('NONE', { NONE: 0.9, '1': 0.1 }) }))).toEqual({ kind: 'click', target: { box } });
  });
  it('types only text taken from the goal', () => {
    const typing = input({ goal: 'Search for "wireless mouse"' });
    const [id] = Object.entries((buildVisionStep(typing).questions.text as any).criteria).find(([, c]) => String(c).includes('wireless mouse'))!;
    expect(readVisionStep(typing, result({ op: choice('TYPE', { TYPE: 1 }), text: choice(id, { NONE: 0, [id]: 1 }) }))).toEqual({ kind: 'type', target: { box }, text: 'wireless mouse' });
    expect(readVisionStep(typing, result({ op: choice('TYPE', { TYPE: 1 }), text: choice('NONE', { NONE: 1, [id]: 0 }) }))).toEqual({ kind: 'give_up', reason: 'NO_TEXT' });
  });
  it('refines on a crop and asks about a repeat with the screen attached', () => {
    expect(refineCrop({ x: 10, y: 790 }, { width: 1280, height: 800 })).toEqual({ x: 0, y: 400, width: 400, height: 400 });
    expect(Object.keys(buildRefineStep('g', [], screen).assets!)).toHaveLength(1);
    expect(readRefineStep(result({ target: { type: 'box', box, confidence: 0.9 } }))).toEqual(box);
    expect(readRefineStep(result({ visible: { type: 'noul', noul: 0.2 } }))).toBeUndefined();
    const repeat = buildRepeatCheck('Click Save', ['clicked "Save"'], screen, 'clicked "Save"');
    expect(validateJevRequest(repeat, enabled).questions.again.type).toBe('noul');
    expect(repeatNeeded(result({ again: { type: 'noul', noul: 0.2 } }))).toBe(false);
  });
});
