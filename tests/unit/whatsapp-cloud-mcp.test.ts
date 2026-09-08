/**
 * Unit tests for the WhatsApp Cloud MCP tool module
 * (mcp/tools/whatsapp-cloud/module.ts) — Phase 2 of the WhatsApp
 * feature-parity plan adds `reply_to_message_id` (quote) and `message_id`
 * (clear the ⏳ ack the webhook left on the inbound message).
 *
 * Unlike the Baileys module, this one talks to Meta directly, so the seam to
 * mock is the compiled client it imports from dist/ (mcp/** may never import
 * src/ — see tests/unit/mcp-no-src-imports.test.ts).
 */
const sendText = jest.fn(async () => ({ messages: [{ id: 'wamid.out' }] }) as Record<string, unknown>);
const removeReaction = jest.fn(async () => undefined);
// Phase 3 send modes — shared module-level mocks (not per-instance like
// uploadMedia below) so a test can assert on them without reaching into the
// constructor's return value.
const sendInteractiveButtons = jest.fn(async () => ({ messages: [{ id: 'wamid.out' }] }) as Record<string, unknown>);
const sendInteractiveList = jest.fn(async () => ({ messages: [{ id: 'wamid.out' }] }) as Record<string, unknown>);
const sendTemplate = jest.fn(async () => ({ messages: [{ id: 'wamid.out' }] }) as Record<string, unknown>);

// Media send path — hoisted to module level (rather than the per-instance
// jest.fn()s these used to be) so the auto-optimize suite below can assert
// exactly which path and mime got uploaded.
const uploadMedia = jest.fn(async () => ({ mediaId: 'media-1' }) as Record<string, unknown>);
const sendImage = jest.fn(async () => ({ messages: [{ id: 'wamid.out' }] }) as Record<string, unknown>);
const sendDocument = jest.fn(async () => ({ messages: [{ id: 'wamid.out' }] }) as Record<string, unknown>);

jest.mock(
  '../../dist/api/whatsapp-cloud-client.js',
  () => ({
    WhatsAppCloudClient: jest.fn().mockImplementation(() => ({
      sendText,
      removeReaction,
      sendInteractiveButtons,
      sendInteractiveList,
      sendTemplate,
      uploadMedia,
      sendImage,
      sendDocument,
    })),
  }),
  { virtual: true },
);

/**
 * The outbound image cap, faked small so these tests can use byte-sized
 * fixtures instead of writing 20MB files. The module reads it off MediaStore
 * — the same value the Baileys channel measures against — through dist/, the
 * only path mcp/** may import from.
 */
const FAKE_IMAGE_CAP = 1000;
jest.mock(
  '../../dist/history/media-store.js',
  () => ({ MediaStore: { maxUploadBytes: 1000 } }),
  { virtual: true },
);

/** Passthrough by default — "nothing could be gained", same as the real contract. */
const optimizeImageFile = jest.fn(async (p: string, _maxBytes: number) => p);
jest.mock(
  '../../dist/shared/image-optimize.js',
  () => ({ optimizeImageFile: (...a: unknown[]) => optimizeImageFile(...(a as [string, number])) }),
  { virtual: true },
);

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WhatsAppCloudModule, buildTemplateComponents } from '../../mcp/tools/whatsapp-cloud/module';

/** `sendText` declares no parameters on the mock, so read args loosely. */
const sendTextCalls = (): unknown[][] => (sendText as unknown as { mock: { calls: unknown[][] } }).mock.calls;
const removeReactionCalls = (): unknown[][] =>
  (removeReaction as unknown as { mock: { calls: unknown[][] } }).mock.calls;
const callsOf = (fn: unknown): unknown[][] => (fn as { mock: { calls: unknown[][] } }).mock.calls;

describe('WhatsAppCloudModule — Phase 2 params', () => {
  const restore: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'GATEWAY_ORIGIN_CHANNEL',
    'WHATSAPP_CLOUD_ACCESS_TOKEN',
    'WHATSAPP_CLOUD_PHONE_NUMBER_ID',
    'WHATSAPP_CLOUD_REACTION_LEVEL',
    'WHATSAPP_CLOUD_TEMPLATES_ENABLED',
    'WHATSAPP_CLOUD_DM_POLICY',
    'WHATSAPP_CLOUD_DM_ALLOWLIST',
  ];

  beforeEach(() => {
    for (const k of ENV_KEYS) restore[k] = process.env[k];
    process.env.WHATSAPP_CLOUD_ACCESS_TOKEN = 'test-token';
    process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID = '1234567890';
    delete process.env.WHATSAPP_CLOUD_REACTION_LEVEL;
    delete process.env.WHATSAPP_CLOUD_TEMPLATES_ENABLED;
    // These tests exercise send behavior, not the DM allowlist gate itself
    // (see the dedicated describe block for that) — 'open' keeps every
    // chat_id in this suite allowed.
    process.env.WHATSAPP_CLOUD_DM_POLICY = 'open';
    delete process.env.WHATSAPP_CLOUD_DM_ALLOWLIST;
    sendText.mockClear();
    removeReaction.mockClear();
    sendInteractiveButtons.mockClear();
    sendInteractiveList.mockClear();
    sendTemplate.mockClear();
    sendInteractiveButtons.mockResolvedValue({ messages: [{ id: 'wamid.out' }] });
    sendInteractiveList.mockResolvedValue({ messages: [{ id: 'wamid.out' }] });
    sendTemplate.mockResolvedValue({ messages: [{ id: 'wamid.out' }] });
    sendText.mockResolvedValue({ messages: [{ id: 'wamid.out' }] });
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (restore[k] === undefined) delete process.env[k];
      else process.env[k] = restore[k];
    }
  });

  /** Both ack-clears are fired-and-forgotten — give the microtask queue a turn. */
  async function settle(): Promise<void> {
    await new Promise((r) => setImmediate(r));
  }

  test('getTools() advertises the two new optional params, still requiring only chat_id', () => {
    const tools = new WhatsAppCloudModule().getTools();
    expect(tools.map((t) => t.name)).toEqual(['whatsapp_cloud_reply']);
    const schema = tools[0].inputSchema as { required: string[]; properties: Record<string, unknown> };
    expect(schema.required).toEqual(['chat_id']);
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['reply_to_message_id', 'message_id']),
    );
  });

  test('reply_to_message_id is passed to sendText as the quote target', async () => {
    const res = await new WhatsAppCloudModule().handleTool('whatsapp_cloud_reply', {
      chat_id: '66812345678',
      text: 'answering that',
      reply_to_message_id: 'wamid.inbound',
    });
    expect(res.isError).toBeFalsy();
    expect(sendTextCalls()[0]).toEqual(['66812345678', 'answering that', 'wamid.inbound']);
  });

  test('no reply_to_message_id → sendText gets undefined, i.e. the pre-Phase-2 call', async () => {
    await new WhatsAppCloudModule().handleTool('whatsapp_cloud_reply', {
      chat_id: '66812345678',
      text: 'hi',
    });
    expect(sendTextCalls()[0]).toEqual(['66812345678', 'hi', undefined]);
  });

  test('message_id clears the ⏳ ack after a successful send', async () => {
    await new WhatsAppCloudModule().handleTool('whatsapp_cloud_reply', {
      chat_id: '66812345678',
      text: 'hi',
      message_id: 'wamid.inbound',
    });
    await settle();
    expect(removeReactionCalls()[0]).toEqual(['66812345678', 'wamid.inbound']);
  });

  test('a FAILED send never clears the ack — the ⏳ stays until something is actually delivered', async () => {
    sendText.mockResolvedValue({ error: { message: 'rate limited', code: 131056 } });
    const res = await new WhatsAppCloudModule().handleTool('whatsapp_cloud_reply', {
      chat_id: '66812345678',
      text: 'hi',
      message_id: 'wamid.inbound',
    });
    await settle();
    expect(res.isError).toBe(true);
    expect(removeReaction).not.toHaveBeenCalled();
  });

  test("WHATSAPP_CLOUD_REACTION_LEVEL=off → nothing to clear, so no reaction call is made", async () => {
    process.env.WHATSAPP_CLOUD_REACTION_LEVEL = 'off';
    await new WhatsAppCloudModule().handleTool('whatsapp_cloud_reply', {
      chat_id: '66812345678',
      text: 'hi',
      message_id: 'wamid.inbound',
    });
    await settle();
    expect(removeReaction).not.toHaveBeenCalled();
  });

  test('no message_id → no reaction call (nothing was acked to clear)', async () => {
    await new WhatsAppCloudModule().handleTool('whatsapp_cloud_reply', {
      chat_id: '66812345678',
      text: 'hi',
    });
    await settle();
    expect(removeReaction).not.toHaveBeenCalled();
  });

  test('best-effort: a rejected removeReaction never turns a delivered reply into an error', async () => {
    removeReaction.mockRejectedValueOnce(new Error('reaction gone'));
    const res = await new WhatsAppCloudModule().handleTool('whatsapp_cloud_reply', {
      chat_id: '66812345678',
      text: 'hi',
      message_id: 'wamid.inbound',
    });
    await settle();
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/Sent message to WhatsApp/);
  });
});

/**
 * Phase 3 — the Cloud-only send modes routed by `whatsapp_cloud_reply`:
 * interactive buttons/lists, and pre-approved templates behind the
 * `templatesEnabled` opt-in (which reaches this subprocess as
 * WHATSAPP_CLOUD_TEMPLATES_ENABLED).
 */
describe('WhatsAppCloudModule — Phase 3 interactive + templates', () => {
  const restore: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'GATEWAY_ORIGIN_CHANNEL',
    'WHATSAPP_CLOUD_ACCESS_TOKEN',
    'WHATSAPP_CLOUD_PHONE_NUMBER_ID',
    'WHATSAPP_CLOUD_REACTION_LEVEL',
    'WHATSAPP_CLOUD_TEMPLATES_ENABLED',
    'WHATSAPP_CLOUD_DM_POLICY',
    'WHATSAPP_CLOUD_DM_ALLOWLIST',
  ];

  beforeEach(() => {
    for (const k of ENV_KEYS) restore[k] = process.env[k];
    process.env.WHATSAPP_CLOUD_ACCESS_TOKEN = 'test-token';
    process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID = '1234567890';
    delete process.env.WHATSAPP_CLOUD_REACTION_LEVEL;
    delete process.env.WHATSAPP_CLOUD_TEMPLATES_ENABLED;
    process.env.WHATSAPP_CLOUD_DM_POLICY = 'open';
    delete process.env.WHATSAPP_CLOUD_DM_ALLOWLIST;
    for (const fn of [sendText, removeReaction, sendInteractiveButtons, sendInteractiveList, sendTemplate]) {
      fn.mockClear();
    }
    sendText.mockResolvedValue({ messages: [{ id: 'wamid.out' }] });
    sendInteractiveButtons.mockResolvedValue({ messages: [{ id: 'wamid.out' }] });
    sendInteractiveList.mockResolvedValue({ messages: [{ id: 'wamid.out' }] });
    sendTemplate.mockResolvedValue({ messages: [{ id: 'wamid.out' }] });
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (restore[k] === undefined) delete process.env[k];
      else process.env[k] = restore[k];
    }
  });

  const reply = (args: Record<string, unknown>) =>
    new WhatsAppCloudModule().handleTool('whatsapp_cloud_reply', args);

  /** The ack-clear is fired-and-forgotten — give the microtask queue a turn. */
  const settle = (): Promise<unknown> => new Promise((r) => setImmediate(r));

  describe('buttons', () => {
    test('buttons route to sendInteractiveButtons, with text as the question body', async () => {
      const res = await reply({
        chat_id: '66812345678',
        text: 'Confirm your booking?',
        buttons: [
          { id: 'yes', title: 'Yes' },
          { id: 'no', title: 'No' },
        ],
      });
      expect(res.isError).toBeFalsy();
      expect(sendText).not.toHaveBeenCalled();
      expect(callsOf(sendInteractiveButtons)[0]).toEqual([
        '66812345678',
        'Confirm your booking?',
        [
          { id: 'yes', title: 'Yes' },
          { id: 'no', title: 'No' },
        ],
      ]);
    });

    // The client throws on a 4th button; the tool must turn that into a
    // readable error rather than an unhandled rejection.
    test('the client’s 3-button limit surfaces as a tool error, not a crash', async () => {
      sendInteractiveButtons.mockRejectedValueOnce(
        new Error('sendInteractiveButtons: WhatsApp allows at most 3 buttons, got 4. Use a list message (sendInteractiveList) for more options.'),
      );
      const res = await reply({
        chat_id: '66812345678',
        text: 'Pick',
        buttons: [
          { id: 'a', title: 'A' },
          { id: 'b', title: 'B' },
          { id: 'c', title: 'C' },
          { id: 'd', title: 'D' },
        ],
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/at most 3 buttons/);
    });

    // A model that decided against offering choices sometimes still emits the
    // key — that must send normal text, not fail.
    test('an empty buttons array falls through to a plain text send', async () => {
      await reply({ chat_id: '66812345678', text: 'hi', buttons: [] });
      expect(sendInteractiveButtons).not.toHaveBeenCalled();
      expect(sendTextCalls()[0]).toEqual(['66812345678', 'hi', undefined]);
    });

    test('half-specified buttons (missing id or title) are dropped, not sent blank', async () => {
      await reply({
        chat_id: '66812345678',
        text: 'Pick',
        buttons: [{ id: 'ok', title: 'OK' }, { id: 'no-title' }, { title: 'no id' }, 'nonsense'],
      });
      expect(callsOf(sendInteractiveButtons)[0]![2]).toEqual([{ id: 'ok', title: 'OK' }]);
    });

    test('buttons still clear the ⏳ ack afterwards, same as a text reply', async () => {
      await reply({
        chat_id: '66812345678',
        text: 'Pick',
        buttons: [{ id: 'a', title: 'A' }],
        message_id: 'wamid.inbound',
      });
      await settle();
      expect(removeReactionCalls()[0]).toEqual(['66812345678', 'wamid.inbound']);
    });
  });

  describe('list', () => {
    test('list routes to sendInteractiveList with the button label and sections', async () => {
      const sections = [{ title: 'Morning', rows: [{ id: 'slot-9', title: '09:00' }] }];
      await reply({
        chat_id: '66812345678',
        text: 'Choose a time',
        list: { button_label: 'Open slots', sections },
      });
      expect(sendText).not.toHaveBeenCalled();
      expect(callsOf(sendInteractiveList)[0]).toEqual([
        '66812345678',
        'Choose a time',
        'Open slots',
        sections,
      ]);
    });

    test('a list missing its button_label is a tool error, not a malformed send', async () => {
      const res = await reply({
        chat_id: '66812345678',
        text: 'Choose',
        list: { sections: [{ title: 'A', rows: [{ id: 'r', title: 'R' }] }] },
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/button_label/);
      expect(sendInteractiveList).not.toHaveBeenCalled();
    });

    test('a list with no sections is a tool error', async () => {
      const res = await reply({ chat_id: '66812345678', text: 'Choose', list: { button_label: 'Open', sections: [] } });
      expect(res.isError).toBe(true);
      expect(sendInteractiveList).not.toHaveBeenCalled();
    });

    test('buttons take precedence when both buttons and list are given', async () => {
      await reply({
        chat_id: '66812345678',
        text: 'Pick',
        buttons: [{ id: 'a', title: 'A' }],
        list: { button_label: 'Open', sections: [{ title: 'S', rows: [{ id: 'r', title: 'R' }] }] },
      });
      expect(sendInteractiveButtons).toHaveBeenCalled();
      expect(sendInteractiveList).not.toHaveBeenCalled();
    });
  });

  describe('templates — the templatesEnabled gate', () => {
    // The gate is the whole point of the opt-in: templates are what reach a
    // user OUTSIDE the 24h window, so an un-opted-in agent must be told why,
    // never silently downgraded to a text send that would also fail.
    test('template_name with templates disabled → explicit error, nothing sent', async () => {
      const res = await reply({
        chat_id: '66812345678',
        template_name: 'appointment_reminder',
        template_language: 'en_US',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/templates are not enabled/i);
      expect(res.content[0].text).toMatch(/templatesEnabled/);
      expect(sendTemplate).not.toHaveBeenCalled();
      expect(sendText).not.toHaveBeenCalled();
    });

    test('an explicitly empty WHATSAPP_CLOUD_TEMPLATES_ENABLED counts as disabled', async () => {
      process.env.WHATSAPP_CLOUD_TEMPLATES_ENABLED = '';
      const res = await reply({ chat_id: '66812345678', template_name: 'x', template_language: 'en_US' });
      expect(res.isError).toBe(true);
      expect(sendTemplate).not.toHaveBeenCalled();
    });

    test('with templates enabled, template_name routes to sendTemplate instead of sendText', async () => {
      process.env.WHATSAPP_CLOUD_TEMPLATES_ENABLED = '1';
      const res = await reply({
        chat_id: '66812345678',
        template_name: 'appointment_reminder',
        template_language: 'th',
      });
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toMatch(/Sent WhatsApp template "appointment_reminder"/);
      expect(sendText).not.toHaveBeenCalled();
      expect(callsOf(sendTemplate)[0]).toEqual(['66812345678', 'appointment_reminder', 'th', undefined]);
    });

    // A template body is the approved copy — there is no free-form text to
    // require, so the usual "text cannot be empty" guard must not fire.
    test('a template needs no text — the empty-text guard does not fire', async () => {
      process.env.WHATSAPP_CLOUD_TEMPLATES_ENABLED = '1';
      const res = await reply({ chat_id: '66812345678', template_name: 'hello_world', template_language: 'en_US' });
      expect(res.isError).toBeFalsy();
    });

    test('template_name without template_language is refused with a clear reason', async () => {
      process.env.WHATSAPP_CLOUD_TEMPLATES_ENABLED = '1';
      const res = await reply({ chat_id: '66812345678', template_name: 'appointment_reminder' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/template_language is required/);
      expect(sendTemplate).not.toHaveBeenCalled();
    });

    test('a failed template send surfaces Meta’s reason and leaves the ack uncleared', async () => {
      process.env.WHATSAPP_CLOUD_TEMPLATES_ENABLED = '1';
      sendTemplate.mockResolvedValue({ error: { message: 'template name does not exist', code: 132001 } });
      const res = await reply({
        chat_id: '66812345678',
        template_name: 'nope',
        template_language: 'en_US',
        message_id: 'wamid.inbound',
      });
      await settle();
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/template name does not exist/);
      expect(removeReaction).not.toHaveBeenCalled();
    });

    test('templates take precedence over buttons and text', async () => {
      process.env.WHATSAPP_CLOUD_TEMPLATES_ENABLED = '1';
      await reply({
        chat_id: '66812345678',
        text: 'hi',
        buttons: [{ id: 'a', title: 'A' }],
        template_name: 'reminder',
        template_language: 'en_US',
      });
      expect(sendTemplate).toHaveBeenCalled();
      expect(sendInteractiveButtons).not.toHaveBeenCalled();
      expect(sendText).not.toHaveBeenCalled();
    });
  });

  describe('buildTemplateComponents()', () => {
    test('the simple form — an array of strings becomes one positional body component', () => {
      expect(buildTemplateComponents(['Alice', '3pm'])).toEqual([
        {
          type: 'body',
          parameters: [
            { type: 'text', text: 'Alice' },
            { type: 'text', text: '3pm' },
          ],
        },
      ]);
    });

    test('numbers are stringified into text parameters', () => {
      expect(buildTemplateComponents([42])).toEqual([
        { type: 'body', parameters: [{ type: 'text', text: '42' }] },
      ]);
    });

    // The advanced form exists because header/button/currency parameters
    // cannot be expressed positionally — those must reach Meta untouched.
    test('the advanced form — an array of objects is passed through verbatim', () => {
      const raw = [{ type: 'header', parameters: [{ type: 'image', image: { id: '1' } }] }];
      expect(buildTemplateComponents(raw)).toBe(raw);
    });

    test('missing / empty / non-array params yield undefined (no components key)', () => {
      expect(buildTemplateComponents(undefined)).toBeUndefined();
      expect(buildTemplateComponents([])).toBeUndefined();
      expect(buildTemplateComponents('Alice')).toBeUndefined();
    });

    test('template_params reach sendTemplate as built components', async () => {
      process.env.WHATSAPP_CLOUD_TEMPLATES_ENABLED = '1';
      await reply({
        chat_id: '66812345678',
        template_name: 'appointment_reminder',
        template_language: 'en_US',
        template_params: ['Alice', '3pm'],
      });
      expect(callsOf(sendTemplate)[0]![3]).toEqual([
        {
          type: 'body',
          parameters: [
            { type: 'text', text: 'Alice' },
            { type: 'text', text: '3pm' },
          ],
        },
      ]);
    });
  });
});

/**
 * Outbound image auto-optimize.
 *
 * An over-cap photo used to reach Meta as-is and get rejected, losing the whole
 * reply. It is now downscaled first. The line that matters most here is the one
 * these tests draw around it: a DOCUMENT send must still deliver its exact
 * bytes. The Cloud API has no single force-document toggle — the extension-based
 * image-vs-document routing IS this channel's version of Baileys' `asDocument`,
 * so "not an image/*" is exactly the condition that must skip optimization.
 */
describe('WhatsAppCloudModule — outbound image auto-optimize', () => {
  const restore: Record<string, string | undefined> = {};
  const ENV_KEYS = ['WHATSAPP_CLOUD_ACCESS_TOKEN', 'WHATSAPP_CLOUD_PHONE_NUMBER_ID', 'WHATSAPP_CLOUD_DM_POLICY', 'WHATSAPP_CLOUD_DM_ALLOWLIST'];
  let tmpDir: string;

  beforeEach(() => {
    for (const k of ENV_KEYS) restore[k] = process.env[k];
    process.env.WHATSAPP_CLOUD_ACCESS_TOKEN = 'test-token';
    process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID = '1234567890';
    process.env.WHATSAPP_CLOUD_DM_POLICY = 'open';
    delete process.env.WHATSAPP_CLOUD_DM_ALLOWLIST;
    for (const fn of [sendText, uploadMedia, sendImage, sendDocument, optimizeImageFile]) fn.mockClear();
    optimizeImageFile.mockImplementation(async (p: string, _maxBytes: number) => p);
    uploadMedia.mockResolvedValue({ mediaId: 'media-1' });
    sendImage.mockResolvedValue({ messages: [{ id: 'wamid.out' }] });
    sendDocument.mockResolvedValue({ messages: [{ id: 'wamid.out' }] });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-cloud-optimize-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (restore[k] === undefined) delete process.env[k];
      else process.env[k] = restore[k];
    }
  });

  /** Writes a fixture of an exact byte size — contents are never decoded here. */
  function fixture(name: string, bytes: number): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, Buffer.alloc(bytes, 0xab));
    return p;
  }

  const reply = (args: Record<string, unknown>) =>
    new WhatsAppCloudModule().handleTool('whatsapp_cloud_reply', args);

  test('an over-cap photo is optimized first, and the OPTIMIZED path is what gets uploaded', async () => {
    const src = fixture('huge.png', FAKE_IMAGE_CAP + 500);
    const shrunk = fixture('huge-optimized.jpg', 200);
    optimizeImageFile.mockImplementation(async () => shrunk);

    const res = await reply({ chat_id: '66812345678', text: 'chart', files: [src] });

    expect(res.isError).toBeFalsy();
    expect(callsOf(optimizeImageFile)[0]).toEqual([src, FAKE_IMAGE_CAP]);
    // The mime must follow the bytes: optimizeImageFile always emits JPEG.
    expect(callsOf(uploadMedia)[0]).toEqual([shrunk, 'image/jpeg']);
    expect(callsOf(sendImage)[0]).toEqual(['66812345678', 'media-1', 'chart']);
  });

  test('a photo already under the cap is uploaded untouched — optimization never runs', async () => {
    const src = fixture('small.png', FAKE_IMAGE_CAP - 1);

    await reply({ chat_id: '66812345678', text: 'ok', files: [src] });

    expect(optimizeImageFile).not.toHaveBeenCalled();
    expect(callsOf(uploadMedia)[0]).toEqual([src, 'image/png']);
  });

  test('an over-cap DOCUMENT is never optimized — exact bytes, original mime', async () => {
    const src = fixture('report.pdf', FAKE_IMAGE_CAP + 500);

    await reply({ chat_id: '66812345678', text: 'the report', files: [src] });

    expect(optimizeImageFile).not.toHaveBeenCalled();
    expect(callsOf(uploadMedia)[0]).toEqual([src, 'application/pdf']);
    expect(sendImage).not.toHaveBeenCalled();
    expect(callsOf(sendDocument)[0]).toEqual(['66812345678', 'media-1', 'report.pdf', 'the report']);
  });

  test('when optimization gains nothing it returns the source path — original mime is kept', async () => {
    const src = fixture('incompressible.png', FAKE_IMAGE_CAP + 500);
    // The real contract: no gain → the SAME path back, not a JPEG copy.
    optimizeImageFile.mockImplementation(async (p: string) => p);

    await reply({ chat_id: '66812345678', text: 'hm', files: [src] });

    expect(optimizeImageFile).toHaveBeenCalled();
    expect(callsOf(uploadMedia)[0]).toEqual([src, 'image/png']);
  });

  test('a rejected optimizeImageFile falls back to the original bytes instead of losing the reply', async () => {
    const src = fixture('boom.png', FAKE_IMAGE_CAP + 500);
    optimizeImageFile.mockImplementation(async () => {
      throw new Error('sharp exploded');
    });

    const res = await reply({ chat_id: '66812345678', text: 'still try', files: [src] });

    expect(res.isError).toBeFalsy();
    expect(callsOf(uploadMedia)[0]).toEqual([src, 'image/png']);
    expect(sendImage).toHaveBeenCalled();
  });
});
