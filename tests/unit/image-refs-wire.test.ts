/**
 * Unit tests for explicit composer reference images on the wire (#73):
 *   - POST /api/v1/agents/:agentId/messages validation of `image_params.image_refs`
 *     (array of non-empty strings, max 5, no duplicates) and its forwarding to the runner.
 *   - AgentRunner.buildImageParamsNote rendering the refs as an <image-params> directive
 *     with nested <ref index="n"> elements, order preserved and XML-escaped, while the
 *     no-refs output stays byte-identical to the legacy single-tag form.
 */
import express from 'express';
import * as supertest from 'supertest';
import { createApiRouter } from '../../src/api/router';
import { AgentRunner } from '../../src/agent/runner';
import { AgentConfig, ApiKey, ApiAttachment, ImageParams } from '../../src/types';

// ── Router fixtures ───────────────────────────────────────────────────────────

const AGENT_ID = 'alfred';

const agentConfig: AgentConfig = {
  id: AGENT_ID,
  description: 'Personal assistant',
  workspace: '/tmp/alfred',
  env: '',
  telegram: { botToken: 'tok' },
  claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
};

const apiKeys: ApiKey[] = [{ key: 'sk-test-app', agents: [AGENT_ID] }];
const AUTH = { Authorization: 'Bearer sk-test-app' };
const POST_URL = `/api/v1/agents/${AGENT_ID}/messages`;

interface SendOpts {
  timeoutMs: number;
  allowTools?: boolean;
  imageParams?: ImageParams;
}

function buildApp(): { app: express.Express; lastOpts: () => SendOpts | undefined } {
  let captured: SendOpts | undefined;
  const runner = {
    async sendApiMessage(
      _sessionId: string,
      _chatId: string,
      _message: string,
      opts: SendOpts,
    ): Promise<{ text: string; attachments: ApiAttachment[] }> {
      captured = opts;
      return { text: 'ok', attachments: [] };
    },
    hasActiveApiSession: () => false,
    getAgentsBaseDir: () => '/tmp',
  };
  const runners = new Map([[AGENT_ID, runner as unknown as AgentRunner]]);
  const configs = new Map([[AGENT_ID, agentConfig]]);
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter(runners, configs, apiKeys));
  return { app, lastOpts: () => captured };
}

const send = (app: express.Express, body: Record<string, unknown>) =>
  supertest.default(app).post(POST_URL).set(AUTH).send({ message: 'draw it', chat_id: 'c1', ...body });

// ── Note-builder helper ───────────────────────────────────────────────────────

const buildNote = (p: ImageParams): string =>
  (AgentRunner as unknown as { buildImageParamsNote: (p: ImageParams) => string })
    .buildImageParamsNote(p);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('image_params.image_refs validation (#73)', () => {
  it('accepts a valid ref array and forwards it to the runner in order', async () => {
    const { app, lastOpts } = buildApp();
    const refs = ['artifact:abc123', 'session-1/cat.png'];
    const res = await send(app, { image_params: { model: 'gpt-image', image_refs: refs } });
    expect(res.status).toBe(200);
    expect(lastOpts()!.imageParams).toEqual({ model: 'gpt-image', image_refs: refs });
  });

  it('accepts image_refs as the only image_params field', async () => {
    const { app, lastOpts } = buildApp();
    const res = await send(app, { image_params: { image_refs: ['artifact:only'] } });
    expect(res.status).toBe(200);
    expect(lastOpts()!.imageParams).toEqual({ image_refs: ['artifact:only'] });
  });

  it('trims ref entries', async () => {
    const { app, lastOpts } = buildApp();
    const res = await send(app, { image_params: { image_refs: ['  artifact:abc  '] } });
    expect(res.status).toBe(200);
    expect(lastOpts()!.imageParams).toEqual({ image_refs: ['artifact:abc'] });
  });

  it('omits image_refs entirely when an empty array is sent', async () => {
    const { app, lastOpts } = buildApp();
    const res = await send(app, { image_params: { model: 'gpt-image', image_refs: [] } });
    expect(res.status).toBe(200);
    expect(lastOpts()!.imageParams).toEqual({ model: 'gpt-image' });
  });

  it.each([
    ['a string instead of an array', 'artifact:abc'],
    ['an object', { 0: 'artifact:abc' }],
    ['a non-string entry', ['artifact:abc', 42]],
    ['an empty-string entry', ['artifact:abc', '']],
    ['a whitespace-only entry', ['artifact:abc', '   ']],
  ])('rejects %s with 400', async (_label, image_refs) => {
    const { app } = buildApp();
    const res = await send(app, { image_params: { image_refs } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('image_params.image_refs must be an array of non-empty strings');
  });

  it('rejects more than 5 refs with 400', async () => {
    const { app } = buildApp();
    const res = await send(app, {
      image_params: { image_refs: ['a', 'b', 'c', 'd', 'e', 'f'] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('image_params.image_refs allows at most 5 references');
  });

  it('accepts exactly 5 refs', async () => {
    const { app } = buildApp();
    const res = await send(app, { image_params: { image_refs: ['a', 'b', 'c', 'd', 'e'] } });
    expect(res.status).toBe(200);
  });

  it('rejects duplicate refs with 400', async () => {
    const { app } = buildApp();
    const res = await send(app, {
      image_params: { image_refs: ['artifact:abc', 'session-1/x.png', 'artifact:abc'] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('image_params.image_refs must not contain duplicates');
  });

  it('rejects refs that only differ by surrounding whitespace as duplicates', async () => {
    const { app } = buildApp();
    const res = await send(app, { image_params: { image_refs: ['artifact:abc', ' artifact:abc '] } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('image_params.image_refs must not contain duplicates');
  });
});

describe('buildImageParamsNote with image_refs (#73)', () => {
  const LEGACY_NOTE =
    '<image-params model="gpt-image" quality="high" />\n' +
    'The user selected the image-generation options above in the composer. When the request ' +
    'involves creating or editing an image, call the generate_image tool (action="generate") ' +
    'using these values (pass image_ref as the "image" argument for image-to-image), then ' +
    'deliver the returned image with your reply tool.\n';

  it('0 refs → legacy self-closing output is unchanged', () => {
    expect(buildNote({ model: 'gpt-image', quality: 'high' })).toBe(LEGACY_NOTE);
    expect(buildNote({ model: 'gpt-image', quality: 'high', image_refs: [] })).toBe(LEGACY_NOTE);
  });

  it('legacy single image_ref keeps the current wording and single-tag form', () => {
    const note = buildNote({ model: 'gpt-image', image_ref: 'artifact:abc' });
    expect(note).toBe(
      '<image-params model="gpt-image" image_ref="artifact:abc" />\n' +
        'The user selected the image-generation options above in the composer. When the request ' +
        'involves creating or editing an image, call the generate_image tool (action="generate") ' +
        'using these values (pass image_ref as the "image" argument for image-to-image), then ' +
        'deliver the returned image with your reply tool.\n',
    );
  });

  it('returns empty string when nothing usable is present', () => {
    expect(buildNote({})).toBe('');
    expect(buildNote({ image_refs: [] })).toBe('');
  });

  it('1 ref → nested <ref> element and "image" argument wording', () => {
    const note = buildNote({ model: 'gpt-image', image_refs: ['artifact:abc123'] });
    expect(note).toContain('<image-params model="gpt-image">\n');
    expect(note).toContain('  <ref index="1">artifact:abc123</ref>\n');
    expect(note).toContain('</image-params>\n');
    expect(note).not.toContain('/>');
    expect(note).toContain('Pass that single ref as the "image" argument of generate_image.');
    expect(note).not.toContain('"images" argument');
    expect(note).toContain('explicitly SELECTED');
    expect(note).toContain('do NOT call list_refs');
  });

  it('3 refs → order preserved, XML-escaped, "images" argument wording', () => {
    const note = buildNote({
      model: 'gpt-image',
      n: 2,
      image_refs: ['artifact:one', 'session-1/a&b "x".png', 'session-1/c<d>.png'],
    });
    expect(note).toBe(
      '<image-params model="gpt-image" n="2">\n' +
        '  <ref index="1">artifact:one</ref>\n' +
        '  <ref index="2">session-1/a&amp;b &quot;x&quot;.png</ref>\n' +
        '  <ref index="3">session-1/c&lt;d&gt;.png</ref>\n' +
        '</image-params>\n' +
        'The user selected the image-generation options above in the composer. When the request ' +
        'involves creating or editing an image, call the generate_image tool (action="generate") ' +
        'using these values, then deliver the returned image with your reply tool.\n' +
        'The user explicitly SELECTED the reference image(s) listed above in the composer, in this order. ' +
        'Pass all 3 refs as the "images" argument of generate_image, in the same order. ' +
        'Do NOT reinterpret which images they are, do NOT call list_refs to ' +
        'second-guess an explicit selection, and do not drop any of them. ' +
        'Do NOT open or Read the referenced files first — the image model receives the actual files; ' +
        'reading them wastes minutes and can push the request past its timeout. Go straight to generate_image.\n',
    );
  });

  it('refs with no other options still render a well-formed open tag', () => {
    const note = buildNote({ image_refs: ['artifact:solo'] });
    expect(note.startsWith('<image-params>\n  <ref index="1">artifact:solo</ref>\n</image-params>\n')).toBe(true);
  });
});

describe('durable image config excludes per-turn refs (#73)', () => {
  const durable = (p: ImageParams): ImageParams | undefined =>
    (AgentRunner as unknown as { durableImageConfig: (p: ImageParams) => ImageParams | undefined })
      .durableImageConfig(p);

  it('strips image_refs from the persisted session image config', () => {
    expect(durable({ model: 'gpt-image', quality: 'high', image_refs: ['artifact:abc'] })).toEqual({
      model: 'gpt-image',
      quality: 'high',
    });
  });

  it('returns undefined when only refs were sent (nothing durable to persist)', () => {
    expect(durable({ image_refs: ['artifact:abc'] })).toBeUndefined();
  });

  it('keeps the legacy image_ref in the durable config (unchanged behavior)', () => {
    expect(durable({ model: 'gpt-image', image_ref: 'artifact:abc' })).toEqual({
      model: 'gpt-image',
      image_ref: 'artifact:abc',
    });
  });
});

describe('remapImageParamsRefs — staging refs follow promoted files (#74)', () => {
  const STAGED = ['media/ui-upload/abc123/one.jpeg', 'media/ui-upload/abc123/two.png'];
  const PROMOTED = ['media/api-s1/1-one.jpeg', 'media/api-s1/2-two.png'];

  const remap = (p: ImageParams | undefined, staged?: string[], promoted?: string[]) =>
    AgentRunner.remapImageParamsRefs(p, staged, promoted);

  it('rewrites image_ref and matching image_refs entries to the promoted paths', () => {
    const out = remap(
      {
        model: 'gpt-image',
        image_ref: STAGED[0],
        image_refs: ['artifact:img_keep', STAGED[0]!, STAGED[1]!],
      },
      STAGED,
      PROMOTED,
    );
    expect(out).toEqual({
      model: 'gpt-image',
      image_ref: PROMOTED[0],
      image_refs: ['artifact:img_keep', PROMOTED[0], PROMOTED[1]],
    });
  });

  it('leaves catalog/artifact refs untouched and preserves order', () => {
    const refs = ['api-s1/old-upload.jpeg', 'artifact:img_x'];
    const out = remap({ image_refs: [...refs] }, STAGED, PROMOTED);
    expect(out!.image_refs).toEqual(refs);
  });

  it('is a no-op without params, without media files, or when promotion failed (same path back)', () => {
    expect(remap(undefined, STAGED, PROMOTED)).toBeUndefined();
    const p: ImageParams = { image_refs: [STAGED[0]!] };
    expect(remap(p, undefined, undefined)).toBe(p);
    // promoteUiUploads returns the ORIGINAL path when a move fails — no mapping entry.
    expect(remap(p, STAGED, [...STAGED])).toBe(p);
  });

  it('does not add ref fields that were not present', () => {
    const out = remap({ model: 'gpt-image' }, STAGED, PROMOTED);
    expect(out).toEqual({ model: 'gpt-image' });
  });
});
