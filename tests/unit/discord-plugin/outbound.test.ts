import { sendMessage, chunkText, buildChoiceComponents } from '../../../mcp/tools/discord/outbound';
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

describe('buildChoiceComponents', () => {
  it('builds one ActionRow for 3 options plus cancel row', () => {
    const rows = buildChoiceComponents([{ label: 'Alpha' }, { label: 'Beta' }, { label: 'Gamma' }]);
    // 1 option row + 1 cancel row
    expect(rows).toHaveLength(2);
    const row = rows[0] as { type: number; components: Array<{ type: number; style: number; label: string; custom_id: string }> };
    expect(row.type).toBe(1);
    expect(row.components).toHaveLength(3);
    expect(row.components[0]).toMatchObject({ type: 2, style: 2, label: '1. Alpha', custom_id: 'choice:1' });
    expect(row.components[2]).toMatchObject({ custom_id: 'choice:3' });
    const cancelRow = rows[1] as { type: number; components: Array<{ type: number; style: number; label: string; custom_id: string }> };
    expect(cancelRow.components[0]).toMatchObject({ type: 2, style: 4, label: '❌ Cancel', custom_id: 'menu:cancel' });
  });

  it('splits into multiple ActionRows when >5 options', () => {
    const opts = Array.from({ length: 7 }, (_, i) => ({ label: `Option ${i + 1}` }));
    const rows = buildChoiceComponents(opts);
    // 2 option rows + 1 cancel row
    expect(rows).toHaveLength(3);
    const row0 = rows[0] as { components: unknown[] };
    const row1 = rows[1] as { components: unknown[] };
    const row2 = rows[2] as { components: Array<{ custom_id: string }> };
    expect(row0.components).toHaveLength(5);
    expect(row1.components).toHaveLength(2);
    expect(row2.components[0].custom_id).toBe('menu:cancel');
  });

  it('caps label at 80 characters', () => {
    const longLabel = 'A'.repeat(100);
    const rows = buildChoiceComponents([{ label: longLabel }]);
    const row = rows[0] as { components: Array<{ label: string }> };
    expect(row.components[0].label.length).toBeLessThanOrEqual(80);
  });

  it('caps at 5 ActionRows (25 options max rendered)', () => {
    const opts = Array.from({ length: 30 }, (_, i) => ({ label: `Opt ${i + 1}` }));
    const rows = buildChoiceComponents(opts);
    expect(rows.length).toBeLessThanOrEqual(5);
  });

  it('returns empty array for no options', () => {
    expect(buildChoiceComponents([])).toHaveLength(0);
  });
});
