/**
 * Unit tests for the Slack inbound normalization path
 * (src/api/slack-webhook-router.ts):
 *
 *  - normalizeSlackEvent — the Slack Events API → {content, meta} intake shape,
 *    with focus on the bot self-mention stripping added for app_mention text
 *    (an app_mention is delivered with the raw `<@Ubot>` markup inline, which is
 *    noise to the agent).
 *  - inbound image download — `meta.image_path`. normalizeSlackEvent stays pure
 *    and synchronous, so the download happens in the async handler right after
 *    it; the only way to exercise it is to drive the REAL handler with a signed
 *    request (mirrors tests/unit/cli-line-e2e.test.ts's approach) and inspect
 *    what gets forwarded to the agent's /channel callback.
 */
import { createHmac } from 'crypto';
import * as fs from 'fs';
import { createSlackWebhookHandler, normalizeSlackEvent } from '../../src/api/slack-webhook-router';
import type { AgentRunner } from '../../src/agent/runner';

const BOT = 'U0BOT';

describe('normalizeSlackEvent() — bot mention stripping', () => {
  test('strips the leading bot self-mention from app_mention text', () => {
    const norm = normalizeSlackEvent(
      { type: 'app_mention', channel: 'C123', user: 'U456', text: `<@${BOT}> hello there`, ts: '1.2' },
      undefined,
      BOT,
    );
    expect(norm?.content).toBe('hello there');
  });

  test('strips an embedded bot self-mention and collapses extra whitespace', () => {
    const norm = normalizeSlackEvent(
      { type: 'app_mention', channel: 'C123', user: 'U456', text: `hey <@${BOT}> please help`, ts: '1.2' },
      undefined,
      BOT,
    );
    expect(norm?.content).toBe('hey please help');
  });

  test('strips a labeled bot mention (<@Ubot|name>)', () => {
    const norm = normalizeSlackEvent(
      { type: 'app_mention', channel: 'C123', user: 'U456', text: `<@${BOT}|somdebot> ping`, ts: '1.2' },
      undefined,
      BOT,
    );
    expect(norm?.content).toBe('ping');
  });

  test('leaves OTHER users\' mentions intact — only the bot id is removed', () => {
    const norm = normalizeSlackEvent(
      { type: 'app_mention', channel: 'C123', user: 'U456', text: `<@${BOT}> ask <@U999> about it`, ts: '1.2' },
      undefined,
      BOT,
    );
    expect(norm?.content).toBe('ask <@U999> about it');
  });

  test('no-op when the bot id is unknown (text passes through verbatim)', () => {
    const norm = normalizeSlackEvent(
      { type: 'app_mention', channel: 'C123', user: 'U456', text: `<@${BOT}> hi`, ts: '1.2' },
      undefined,
      undefined,
    );
    expect(norm?.content).toBe(`<@${BOT}> hi`);
  });

  test('carries thread_ts into meta when the message is threaded', () => {
    const norm = normalizeSlackEvent(
      { type: 'message', channel: 'D123', channel_type: 'im', user: 'U456', text: 'in thread', ts: '2.0', thread_ts: '1.0' },
      undefined,
      BOT,
    );
    expect(norm?.meta.thread_ts).toBe('1.0');
    expect(norm?.content).toBe('in thread');
  });

  test('returns null for bot-authored events (bot-loop protection)', () => {
    const norm = normalizeSlackEvent(
      { type: 'message', channel: 'C123', user: 'U456', bot_id: 'B1', text: 'loop', ts: '1.2' },
      undefined,
      BOT,
    );
    expect(norm).toBeNull();
  });
});

describe('inbound image download → meta.image_path', () => {
  const AGENT = 'slack-agent';
  const SECRET = 'test-signing-secret';
  const TOKEN = 'xoxb-inbound-test';
  const DM = 'D999';
  const USER = 'U456';
  const PRIVATE_URL = 'https://files.slack.com/files-pri/T1-F1/pic.png';
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22]);

  const realFetch = global.fetch;
  let handler: ReturnType<typeof createSlackWebhookHandler>;
  let forwarded: Array<{ content: string; meta: Record<string, string> }>;
  let downloadInits: RequestInit[];
  let fetchedUrls: string[];
  let downloadResponse: () => Response | Promise<Response>;
  const written: string[] = [];

  function fakeRunner(): AgentRunner {
    return {
      getAgentConfig: () => ({
        id: AGENT,
        slack: { botToken: TOKEN, signingSecret: SECRET, dmPolicy: 'open' },
      }),
      getCallbackPort: () => 0,
    } as unknown as AgentRunner;
  }

  function makeRes() {
    const res = { status: jest.fn(), json: jest.fn() };
    res.status.mockReturnValue(res as never);
    res.json.mockReturnValue(res as never);
    return res;
  }

  /** Drive the real handler with a correctly signed event_callback. */
  function post(event: Record<string, unknown>, eventId = `Ev${Math.random()}`) {
    const buf = Buffer.from(
      JSON.stringify({
        type: 'event_callback',
        event_id: eventId,
        event,
        authorizations: [{ user_id: BOT }],
      }),
    );
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `v0=${createHmac('sha256', SECRET).update(`v0:${ts}:${buf.toString('utf8')}`).digest('hex')}`;
    const req = {
      params: { agentId: AGENT },
      header: (h: string) => {
        const k = h.toLowerCase();
        if (k === 'x-slack-signature') return sig;
        if (k === 'x-slack-request-timestamp') return ts;
        return undefined;
      },
      headers: {},
      body: buf,
    };
    return handler.handlePost(req as never, makeRes() as never);
  }

  const imageEvent = (files: unknown[]) => ({
    type: 'message',
    subtype: 'file_share',
    channel: DM,
    channel_type: 'im',
    user: USER,
    text: 'look at this',
    ts: '1700000000.000100',
    event_ts: '1700000000.000100',
    files,
  });

  beforeEach(() => {
    forwarded = [];
    downloadInits = [];
    fetchedUrls = [];
    // Default: a real Response, so the streaming read path is genuinely exercised.
    downloadResponse = () => new Response(PNG);
    handler = createSlackWebhookHandler(new Map([[AGENT, fakeRunner()]]), '/tmp');

    global.fetch = (async (input: string, init?: RequestInit) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url === PRIVATE_URL) {
        downloadInits.push(init ?? {});
        return downloadResponse();
      }
      if (url.endsWith('/channel')) {
        forwarded.push(JSON.parse(String(init?.body)));
        return { ok: true, json: async () => ({}) } as Response;
      }
      // Slack Web API (the ack reaction) — always fine.
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    for (const f of written) fs.rmSync(f, { force: true });
    written.length = 0;
  });

  test('image attachment → bytes fetched with the bot token, meta.image_path written to disk', async () => {
    await post(imageEvent([{ id: 'F1', name: 'pic.png', mimetype: 'image/png', url_private: PRIVATE_URL }]));

    expect(forwarded).toHaveLength(1);
    const imgPath = forwarded[0].meta.image_path;
    expect(imgPath).toBeTruthy();
    written.push(imgPath);
    // Extension comes from the magic bytes, not the (untrusted) mimetype field;
    // the Slack file id is embedded so same-millisecond events can't collide.
    expect(imgPath).toMatch(/slack-img-F1-\d+\.png$/);
    expect(fs.readFileSync(imgPath)).toEqual(PNG);

    // url_private is NOT public — it must be fetched with the bot token.
    expect(downloadInits).toHaveLength(1);
    expect((downloadInits[0].headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);

    // The text turn is unaffected by the attachment.
    expect(forwarded[0].content).toBe('look at this');
    expect(forwarded[0].meta.chat_id).toBe(DM);
  });

  test('non-image attachment → skipped entirely, no download, no image_path', async () => {
    await post(imageEvent([{ id: 'F2', name: 'notes.pdf', mimetype: 'application/pdf', url_private: PRIVATE_URL }]));

    expect(downloadInits).toHaveLength(0);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].meta.image_path).toBeUndefined();
    expect(forwarded[0].content).toBe('look at this');
  });

  test('picks the first image when a non-image file precedes it', async () => {
    await post(
      imageEvent([
        { id: 'F2', name: 'notes.pdf', mimetype: 'application/pdf', url_private: 'https://files.slack.com/other' },
        { id: 'F1', name: 'pic.png', mimetype: 'image/png', url_private: PRIVATE_URL },
      ]),
    );
    expect(downloadInits).toHaveLength(1);
    written.push(forwarded[0].meta.image_path);
    expect(forwarded[0].meta.image_path).toBeTruthy();
  });

  test('over-cap image → no image_path, but the text turn still forwards', async () => {
    downloadResponse = () =>
      ({
        ok: true,
        status: 200,
        headers: { get: (h: string) => (h.toLowerCase() === 'content-length' ? String(21 * 1024 * 1024) : null) },
        body: null,
        arrayBuffer: async () => new ArrayBuffer(0),
      }) as unknown as Response;

    await post(imageEvent([{ id: 'F1', name: 'huge.png', mimetype: 'image/png', url_private: PRIVATE_URL }]));

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].meta.image_path).toBeUndefined();
    expect(forwarded[0].content).toBe('look at this');
  });

  test('download failure → message is never dropped, just forwarded without image_path', async () => {
    downloadResponse = () => ({ ok: false, status: 403 }) as unknown as Response;

    await post(imageEvent([{ id: 'F1', name: 'pic.png', mimetype: 'image/png', url_private: PRIVATE_URL }]));

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].meta.image_path).toBeUndefined();
    expect(forwarded[0].content).toBe('look at this');
  });

  test('a thrown fetch (network error) also forwards the turn', async () => {
    downloadResponse = () => {
      throw new Error('ECONNRESET');
    };

    await post(imageEvent([{ id: 'F1', name: 'pic.png', mimetype: 'image/png', url_private: PRIVATE_URL }]));

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].meta.image_path).toBeUndefined();
  });

  test('url_private on a non-Slack host → bot token never sent, no image_path, turn still forwards', async () => {
    // A url_private pointing anywhere other than *.slack.com must be refused
    // BEFORE the fetch, so the bot token can never leak to an attacker host.
    const EVIL = 'https://evil.example.com/files-pri/T1-F1/pic.png';
    await post(imageEvent([{ id: 'F1', name: 'pic.png', mimetype: 'image/png', url_private: EVIL }]));

    // No request was ever made to the evil host (guard runs before fetch).
    expect(downloadInits).toHaveLength(0);
    expect(fetchedUrls).not.toContain(EVIL);
    // The turn is never dropped — it just forwards without an image.
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].meta.image_path).toBeUndefined();
    expect(forwarded[0].content).toBe('look at this');
  });

  test('an event with no files at all is unchanged', async () => {
    await post({
      type: 'message',
      channel: DM,
      channel_type: 'im',
      user: USER,
      text: 'plain text',
      ts: '1700000000.000200',
    });
    expect(downloadInits).toHaveLength(0);
    expect(forwarded[0].meta.image_path).toBeUndefined();
    expect(forwarded[0].content).toBe('plain text');
  });
});
