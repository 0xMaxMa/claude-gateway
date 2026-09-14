/**
 * Unit tests for composer video options on the wire:
 *   - POST /api/v1/agents/:agentId/messages validation of `video_params`
 *     (string model/resolution/aspect_ratio/image_ref, positive-integer duration)
 *     and its forwarding to the runner.
 *   - AgentRunner.buildVideoParamsNote rendering the selection as a <video-params>
 *     directive that makes model/duration/aspect authoritative so the agent stops
 *     inventing a duration cap, splitting into scenes, or flipping the orientation.
 */
import express from 'express';
import * as supertest from 'supertest';
import { createApiRouter } from '../../src/api/router';
import { AgentRunner } from '../../src/agent/runner';
import { AgentConfig, ApiKey, ApiAttachment, VideoParams } from '../../src/types';

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
  videoParams?: VideoParams;
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
  supertest.default(app).post(POST_URL).set(AUTH).send({ message: 'make a clip', chat_id: 'c1', ...body });

// ── Note-builder helper ───────────────────────────────────────────────────────

const buildNote = (p: VideoParams): string =>
  (AgentRunner as unknown as { buildVideoParamsNote: (p: VideoParams) => string })
    .buildVideoParamsNote(p);

// ── Router validation ─────────────────────────────────────────────────────────

describe('video_params validation', () => {
  it('accepts a full composer selection and forwards it to the runner', async () => {
    const { app, lastOpts } = buildApp();
    const video_params = {
      model: 'grok-video/grok-imagine-video-1.5',
      duration: 15,
      resolution: '480p',
      aspect_ratio: '9:16',
    };
    const res = await send(app, { video_params });
    expect(res.status).toBe(200);
    expect(lastOpts()!.videoParams).toEqual(video_params);
  });

  it('trims string fields and floors duration', async () => {
    const { app, lastOpts } = buildApp();
    const res = await send(app, {
      video_params: { model: '  grok-video/x  ', resolution: ' 720p ', duration: 10.9 },
    });
    expect(res.status).toBe(200);
    expect(lastOpts()!.videoParams).toEqual({ model: 'grok-video/x', resolution: '720p', duration: 10 });
  });

  it('carries an image_ref for image-to-video', async () => {
    const { app, lastOpts } = buildApp();
    const res = await send(app, { video_params: { image_ref: 'artifact:frame1' } });
    expect(res.status).toBe(200);
    expect(lastOpts()!.videoParams).toEqual({ image_ref: 'artifact:frame1' });
  });

  it('forwards no videoParams when video_params is absent', async () => {
    const { app, lastOpts } = buildApp();
    const res = await send(app, {});
    expect(res.status).toBe(200);
    expect(lastOpts()!.videoParams).toBeUndefined();
  });

  it.each([
    ['an array', []],
    ['null', null],
    ['a string', 'grok'],
  ])('rejects video_params that is %s with 400', async (_label, video_params) => {
    const { app } = buildApp();
    const res = await send(app, { video_params });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('video_params must be an object if provided');
  });

  it('rejects a non-string model with 400', async () => {
    const { app } = buildApp();
    const res = await send(app, { video_params: { model: 42 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('video_params.model must be a string');
  });

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['non-finite', Number.POSITIVE_INFINITY],
    ['a string', '15'],
  ])('rejects duration that is %s with 400', async (_label, duration) => {
    const { app } = buildApp();
    const res = await send(app, { video_params: { duration } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('video_params.duration must be a positive number');
  });
});

// ── Note builder ──────────────────────────────────────────────────────────────

describe('buildVideoParamsNote', () => {
  it('returns empty string when nothing usable is present', () => {
    expect(buildNote({})).toBe('');
  });

  it('renders the selection as a self-closing <video-params> tag', () => {
    const note = buildNote({
      model: 'grok-video/grok-imagine-video-1.5',
      resolution: '480p',
      aspect_ratio: '9:16',
      duration: 15,
    });
    expect(note).toContain(
      '<video-params model="grok-video/grok-imagine-video-1.5" resolution="480p" aspect_ratio="9:16" duration="15" />\n',
    );
  });

  it('makes the model authoritative and forbids action="list"', () => {
    const note = buildNote({ model: 'grok-video/x' });
    expect(note).toContain('explicitly SELECTED model="grok-video/x"');
    expect(note).toContain('do NOT call action="list"');
  });

  it('nails the duration down — no invented cap, no scene split', () => {
    const note = buildNote({ duration: 15 });
    expect(note).toContain('duration=15 is a valid length');
    expect(note).toContain('do NOT split the request');
    expect(note).toContain('exactly ONE clip');
  });

  it('locks the aspect ratio orientation', () => {
    const note = buildNote({ aspect_ratio: '9:16' });
    expect(note).toContain('Pass aspect_ratio="9:16" verbatim');
  });

  it('routes image_ref to the "image" argument for image-to-video', () => {
    const note = buildNote({ image_ref: 'artifact:frame1' });
    expect(note).toContain('image_ref="artifact:frame1"');
    expect(note).toContain('as the "image" argument of generate_video');
    expect(note).toContain('Do NOT call list_refs');
  });

  it('omits the model note when no model is selected', () => {
    const note = buildNote({ duration: 6 });
    expect(note).not.toContain('explicitly SELECTED model=');
  });
});

describe('remapVideoParamsRefs — the i2v source frame follows promoted files (#74)', () => {
  const STAGED = ['media/ui-upload/abc123/frame.jpeg'];
  const PROMOTED = ['media/api-s1/1-frame.jpeg'];

  const remap = (p: VideoParams | undefined, staged?: string[], promoted?: string[]) =>
    AgentRunner.remapVideoParamsRefs(p, staged, promoted);

  it('rewrites a staged image_ref to its promoted path', () => {
    const out = remap(
      { model: 'grok-imagine-video-1.5', aspect_ratio: '9:16', image_ref: STAGED[0] },
      STAGED,
      PROMOTED,
    );
    expect(out).toEqual({
      model: 'grok-imagine-video-1.5',
      aspect_ratio: '9:16',
      image_ref: PROMOTED[0],
    });
  });

  it('leaves a catalog/artifact source frame untouched', () => {
    const p: VideoParams = { image_ref: 'artifact:frame_x' };
    expect(remap(p, STAGED, PROMOTED)).toBe(p);
  });

  it('is a no-op without params, without an image_ref, without media files, or when promotion failed', () => {
    expect(remap(undefined, STAGED, PROMOTED)).toBeUndefined();
    const noRef: VideoParams = { model: 'grok-imagine-video-1.5', duration: 6 };
    expect(remap(noRef, STAGED, PROMOTED)).toBe(noRef);
    const p: VideoParams = { image_ref: STAGED[0] };
    expect(remap(p, undefined, undefined)).toBe(p);
    // promoteUiUploads returns the ORIGINAL path when a move fails — no mapping entry.
    expect(remap(p, STAGED, [...STAGED])).toBe(p);
  });
});

test('orchestrated API persists composer video options and forwards their authoritative directive', async () => {
  const send = jest.fn(async () => 'ok');
  const update = jest.fn(async () => {});
  const runner = Object.assign(Object.create(AgentRunner.prototype), {
    pendingApiSessions: new Set(), apiChatIds: new Map(), agentConfig: { id: 'a' },
    sessionStore: { ensureApiSession: async () => {}, loadIndex: async () => null, updateSessionMeta: update },
    getOrchestration: async () => ({ send, responseFiles: () => [] }),
    addApiAttachments: () => {}, popApiAttachments: () => [],
  });
  const videoParams = { model: 'video-fixture', duration: 8, aspect_ratio: '9:16', resolution: '720p' };
  await runner.sendOrchestratedApi('s', 'c', 'make a clip', { timeoutMs: 2000, principalId: 'owner', allowTools: true, videoParams });
  const input = (send.mock.calls as unknown as any[][])[0][0];
  expect(input.metadata.promptContext).toContain('<video-params');
  for (const value of ['video-fixture', '8', '9:16', '720p']) expect(input.metadata.promptContext).toContain(value);
  expect(update).toHaveBeenCalledWith('a', 'c', 's', { videoConfig: videoParams }, 'api');
});
