/**
 * Unit tests for the LINE channel's pure logic:
 *  - chunkText / batch  (mcp/tools/line/pure.ts)  — outbound splitting
 *  - normalizeLineEvent (src/api/line-webhook-router.ts) — inbound parsing
 *
 * Signature validation is the SDK's own (validateSignature, HMAC-SHA256 +
 * timing-safe compare) and is trusted here rather than re-tested. No network in
 * this file.
 */
import {
  chunkText,
  batch,
  planLineSend,
  LINE_TEXT_LIMIT,
  LINE_MAX_MESSAGES_PER_REQUEST,
} from '../../mcp/tools/line/pure';
import {
  stripMarkdownPreservingUrls,
  splitForLine,
  LINE_SAFE_BUBBLE_CHARS,
} from '../../src/agent/line-pure';
import { normalizeLineEvent } from '../../src/api/line-webhook-router';
import { LineModule } from '../../mcp/tools/line/module';

describe('chunkText()', () => {
  test('text <= limit → single chunk', () => {
    expect(chunkText('hello', LINE_TEXT_LIMIT)).toEqual(['hello']);
  });

  test('empty string → single empty chunk (callers always have something to send)', () => {
    expect(chunkText('', LINE_TEXT_LIMIT)).toEqual(['']);
  });

  test('text exactly at limit → single chunk', () => {
    const text = 'a'.repeat(LINE_TEXT_LIMIT);
    expect(chunkText(text, LINE_TEXT_LIMIT)).toEqual([text]);
  });

  test('text > limit → hard cut into <=limit pieces', () => {
    const text = 'a'.repeat(LINE_TEXT_LIMIT + 50);
    const out = chunkText(text, LINE_TEXT_LIMIT);
    expect(out).toHaveLength(2);
    expect(out[0]).toHaveLength(LINE_TEXT_LIMIT);
    expect(out[1]).toHaveLength(50);
    expect(out.join('')).toBe(text);
  });

  test('prefers to break on a newline within the limit', () => {
    const text = 'a'.repeat(10) + '\n' + 'b'.repeat(12);
    const out = chunkText(text, 15);
    expect(out[0]).toBe('a'.repeat(10)); // broke at the newline, not at char 15
    expect(out[1]).toBe('b'.repeat(12)); // newline consumed, remainder fits
  });

  test('every chunk respects the limit', () => {
    const text = 'x'.repeat(LINE_TEXT_LIMIT * 3 + 7);
    for (const chunk of chunkText(text, LINE_TEXT_LIMIT)) {
      expect(chunk.length).toBeLessThanOrEqual(LINE_TEXT_LIMIT);
    }
  });
});

describe('batch()', () => {
  test('groups into batches of <= the per-request cap', () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    const groups = batch(items); // default = LINE_MAX_MESSAGES_PER_REQUEST (5)
    expect(groups.map(g => g.length)).toEqual([5, 5, 2]);
    expect(groups.flat()).toEqual(items);
  });

  test('fewer than the cap → single group', () => {
    expect(batch([1, 2, 3])).toEqual([[1, 2, 3]]);
  });

  test('empty input → no groups', () => {
    expect(batch([])).toEqual([]);
  });

  test('cap matches the documented LINE limit', () => {
    expect(LINE_MAX_MESSAGES_PER_REQUEST).toBe(5);
  });
});

describe('planLineSend()', () => {
  test('no reply token → everything pushes (reply API unused)', () => {
    const plan = planLineSend(['a', 'b', 'c'], false);
    expect(plan.replyBatch).toBeNull();
    expect(plan.pushBatches).toEqual([['a', 'b', 'c']]);
  });

  test('with reply token, single batch → reply only, no push', () => {
    const plan = planLineSend(['a', 'b', 'c'], true);
    expect(plan.replyBatch).toEqual(['a', 'b', 'c']);
    expect(plan.pushBatches).toEqual([]);
  });

  test('with reply token, >1 batch → first batch replies (free), rest push', () => {
    const chunks = Array.from({ length: 12 }, (_, i) => `m${i}`);
    const plan = planLineSend(chunks, true);
    expect(plan.replyBatch).toHaveLength(LINE_MAX_MESSAGES_PER_REQUEST); // 5
    expect(plan.replyBatch).toEqual(chunks.slice(0, 5));
    expect(plan.pushBatches.map((b) => b.length)).toEqual([5, 2]); // remaining 7
    expect([...(plan.replyBatch ?? []), ...plan.pushBatches.flat()]).toEqual(chunks);
  });

  test('empty chunks → nothing to reply, no push batches', () => {
    expect(planLineSend([], true)).toEqual({ replyBatch: null, pushBatches: [] });
  });
});

describe('normalizeLineEvent()', () => {
  const textEvent = (over: Record<string, unknown> = {}) =>
    ({
      type: 'message',
      timestamp: 1700000000000,
      replyToken: 'rt-123',
      source: { type: 'user', userId: 'U123' },
      message: { type: 'text', id: 'm1', text: 'สวัสดี' },
      ...over,
    }) as any;

  test('1:1 text message → {content, meta}', () => {
    const norm = normalizeLineEvent(textEvent());
    expect(norm).not.toBeNull();
    expect(norm!.content).toBe('สวัสดี');
    expect(norm!.meta).toMatchObject({
      source: 'line',
      chat_id: 'U123',
      user_id: 'U123',
      user: 'U123',
      message_id: 'm1',
      reply_token: 'rt-123',
    });
    // epoch ms → ISO
    expect(norm!.meta.ts).toBe(new Date(1700000000000).toISOString());
  });

  test('non-message event → null', () => {
    expect(normalizeLineEvent(textEvent({ type: 'follow' }))).toBeNull();
  });

  test('image message → normalized with media_type=image and empty content', () => {
    const norm = normalizeLineEvent(textEvent({ message: { type: 'image', id: 'i1' } }));
    expect(norm).not.toBeNull();
    expect(norm!.content).toBe('');
    expect(norm!.meta.media_type).toBe('image');
    expect(norm!.meta.message_id).toBe('i1');
    expect(norm!.meta.chat_id).toBe('U123');
    // reply_token still flows through so the agent can answer for free
    expect(norm!.meta.reply_token).toBe('rt-123');
  });

  test('other media (e.g. sticker/video) → null (only text + image handled)', () => {
    expect(
      normalizeLineEvent(textEvent({ message: { type: 'sticker', id: 's1' } })),
    ).toBeNull();
    expect(
      normalizeLineEvent(textEvent({ message: { type: 'video', id: 'v1' } })),
    ).toBeNull();
  });

  test('group source → normalized; chat_id=groupId, user_id=sender, line_chat_type=group', () => {
    const norm = normalizeLineEvent(
      textEvent({ source: { type: 'group', groupId: 'G1', userId: 'U123' } }),
    );
    expect(norm).not.toBeNull();
    expect(norm!.meta).toMatchObject({
      chat_id: 'G1',
      user_id: 'U123',
      line_chat_type: 'group',
      reply_token: 'rt-123',
    });
  });

  test('group source without sender userId → user_id falls back to groupId', () => {
    const norm = normalizeLineEvent(textEvent({ source: { type: 'group', groupId: 'G1' } }));
    expect(norm).not.toBeNull();
    expect(norm!.meta.chat_id).toBe('G1');
    expect(norm!.meta.user_id).toBe('G1');
    expect(norm!.meta.line_chat_type).toBe('group');
  });

  test('room source → normalized with line_chat_type=room, chat_id=roomId', () => {
    const norm = normalizeLineEvent(
      textEvent({ source: { type: 'room', roomId: 'R1', userId: 'U123' } }),
    );
    expect(norm).not.toBeNull();
    expect(norm!.meta.chat_id).toBe('R1');
    expect(norm!.meta.line_chat_type).toBe('room');
  });

  test('1:1 text carries line_chat_type=user', () => {
    expect(normalizeLineEvent(textEvent())!.meta.line_chat_type).toBe('user');
  });

  test('group source without a groupId → null', () => {
    expect(normalizeLineEvent(textEvent({ source: { type: 'group' } }))).toBeNull();
  });

  test('user source without userId → null', () => {
    expect(
      normalizeLineEvent(textEvent({ source: { type: 'user' } })),
    ).toBeNull();
  });

  test('omits reply_token when the event has none', () => {
    const norm = normalizeLineEvent(textEvent({ replyToken: undefined }));
    expect(norm).not.toBeNull();
    expect(norm!.meta.reply_token).toBeUndefined();
  });
});

describe('stripMarkdownPreservingUrls()', () => {
  test('empty/undefined passthrough', () => {
    expect(stripMarkdownPreservingUrls('')).toBe('');
  });

  test('markdown link → "label (url)" so the URL stays tappable', () => {
    expect(stripMarkdownPreservingUrls('see [docs](https://a.co/x) now')).toBe(
      'see docs (https://a.co/x) now',
    );
  });

  test('bare URL is left untouched', () => {
    expect(stripMarkdownPreservingUrls('go https://a.co/x')).toBe('go https://a.co/x');
  });

  test('bold/italic/inline-code markers stripped, content kept', () => {
    expect(stripMarkdownPreservingUrls('**bold** *it* `code`')).toBe('bold it code');
  });

  test('code fence: inner content kept, fences dropped', () => {
    expect(stripMarkdownPreservingUrls('```js\nconst a=1;\n```')).toBe('const a=1;');
  });

  test('headings stripped, bullets normalized to •', () => {
    expect(stripMarkdownPreservingUrls('# Title\n- one\n- two')).toBe('Title\n• one\n• two');
  });
});

describe('splitForLine()', () => {
  test('empty → no chunks', () => {
    expect(splitForLine('')).toEqual([]);
  });

  test('short text → single chunk', () => {
    expect(splitForLine('hello')).toEqual(['hello']);
  });

  test('text at the safe limit → single chunk', () => {
    const text = 'a'.repeat(LINE_SAFE_BUBBLE_CHARS);
    expect(splitForLine(text)).toEqual([text]);
  });

  test('prefers paragraph break within budget', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    const out = splitForLine(`${a}\n\n${b}`, 50);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(b);
  });

  test('never exceeds the 5-message budget; final chunk gets an ellipsis', () => {
    const text = 'x'.repeat(LINE_SAFE_BUBBLE_CHARS * 10);
    const out = splitForLine(text);
    expect(out.length).toBeLessThanOrEqual(LINE_MAX_MESSAGES_PER_REQUEST);
    expect(out[out.length - 1].endsWith('…')).toBe(true);
  });
});

describe('LineModule line_reply refresh guard', () => {
  const restore: Record<string, string | undefined> = {};
  beforeEach(() => {
    restore.refresh = process.env.LINE_REPLY_REFRESH;
    restore.token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  });
  afterEach(() => {
    if (restore.refresh === undefined) delete process.env.LINE_REPLY_REFRESH;
    else process.env.LINE_REPLY_REFRESH = restore.refresh;
    if (restore.token === undefined) delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    else process.env.LINE_CHANNEL_ACCESS_TOKEN = restore.token;
  });

  test('LINE_REPLY_REFRESH=1 → no-op handed to gateway, no send attempted', async () => {
    process.env.LINE_REPLY_REFRESH = '1';
    delete process.env.LINE_CHANNEL_ACCESS_TOKEN; // guard must short-circuit before the token check
    const mod = new LineModule();
    const res = await mod.handleTool('line_reply', { chat_id: 'U123', text: 'hi' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/handed to gateway/i);
  });

  test('without refresh + no token → token error (proves the guard is what suppresses)', async () => {
    delete process.env.LINE_REPLY_REFRESH;
    delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const mod = new LineModule();
    const res = await mod.handleTool('line_reply', { chat_id: 'U123', text: 'hi' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/missing LINE_CHANNEL_ACCESS_TOKEN/i);
  });
});
