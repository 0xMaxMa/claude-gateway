import { sendMessage, chunkText } from '../../../mcp/tools/discord/outbound';
import type { SendableChannel, SentMessage } from '../../../mcp/tools/discord/types';

function makeMockChannel(responses?: Partial<SentMessage>[]): SendableChannel & { calls: any[] } {
  const calls: any[] = [];
  let idx = 0;
  return {
    calls,
    async send(options) {
      calls.push(options);
      const id = responses?.[idx]?.id ?? `msg-${idx}`;
      idx++;
      return { id };
    },
  };
}

describe('chunkText', () => {
  it('returns single element for short text', () => {
    const chunks = chunkText('hello', 2000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('hello');
  });

  it('splits at word boundary when over limit', () => {
    const text = 'word '.repeat(500); // ~2500 chars
    const chunks = chunkText(text, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
    expect(chunks.join(' ').replace(/  +/g, ' ').trim()).toBe(text.trim());
  });

  it('splits at newline boundary', () => {
    const text = 'line\n'.repeat(300); // ~1500 chars per 300 lines
    const longText = text.repeat(2);
    const chunks = chunkText(longText, 2000);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });
});

describe('sendMessage', () => {
  it('DO1: short message sends as single call', async () => {
    const channel = makeMockChannel();
    const result = await sendMessage(channel, 'hello world');
    expect(result).toHaveLength(1);
    expect(channel.calls).toHaveLength(1);
    expect(channel.calls[0].content).toBe('hello world');
  });

  it('DO2: long message (>2000 chars) is chunked', async () => {
    const channel = makeMockChannel();
    const longText = 'a '.repeat(1200); // ~2400 chars
    const result = await sendMessage(channel, longText);
    expect(result.length).toBeGreaterThan(1);
    expect(channel.calls.length).toBeGreaterThan(1);
    for (const call of channel.calls) {
      expect((call.content ?? '').length).toBeLessThanOrEqual(2000);
    }
  });

  it('DO3: very long text with useEmbed:true sends embed first', async () => {
    const channel = makeMockChannel();
    const veryLong = 'x'.repeat(5000);
    const result = await sendMessage(channel, veryLong, { useEmbed: true });
    expect(channel.calls[0].embeds).toBeDefined();
    expect(channel.calls[0].embeds[0].description).toHaveLength(4096);
  });

  it('DO4: file attachment is sent as separate message', async () => {
    const channel = makeMockChannel();
    await sendMessage(channel, 'hello', { files: ['/tmp/test.png'] });
    const fileCalls = channel.calls.filter(c => c.files);
    expect(fileCalls).toHaveLength(1);
    expect(fileCalls[0].files[0].attachment).toBe('/tmp/test.png');
  });

  it('includes reply reference on first chunk only', async () => {
    const channel = makeMockChannel();
    const longText = 'a '.repeat(1200);
    await sendMessage(channel, longText, { replyTo: 'msg-ref' });
    expect(channel.calls[0].reply?.messageReference).toBe('msg-ref');
    if (channel.calls.length > 1) {
      expect(channel.calls[1].reply).toBeUndefined();
    }
  });
});
