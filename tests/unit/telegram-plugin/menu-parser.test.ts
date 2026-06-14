import { parseMenuFileContent } from '../../../mcp/tools/telegram/menu-parser';

describe('parseMenuFileContent', () => {
  it('parses a valid menu file into text + inline_keyboard', () => {
    const raw = JSON.stringify({
      text: 'Pick an option:',
      options: [{ label: 'Alpha' }, { label: 'Beta' }, { label: 'Gamma' }],
    });
    const result = parseMenuFileContent(raw);
    expect(result).not.toBeNull();
    expect(result!.text).toBe('Pick an option:');
    expect(result!.inline_keyboard).toHaveLength(3);
    expect(result!.inline_keyboard[0]).toEqual([{ text: '1. Alpha', callback_data: 'choice:1' }]);
    expect(result!.inline_keyboard[2]).toEqual([{ text: '3. Gamma', callback_data: 'choice:3' }]);
  });

  it('caps button label at 60 characters', () => {
    const longLabel = 'Z'.repeat(80);
    const raw = JSON.stringify({ text: 'Q', options: [{ label: longLabel }] });
    const result = parseMenuFileContent(raw);
    expect(result!.inline_keyboard[0][0].text.length).toBeLessThanOrEqual(60);
  });

  it('returns null for invalid JSON', () => {
    expect(parseMenuFileContent('not json')).toBeNull();
    expect(parseMenuFileContent('')).toBeNull();
  });

  it('returns null when text is missing', () => {
    const raw = JSON.stringify({ options: [{ label: 'A' }] });
    expect(parseMenuFileContent(raw)).toBeNull();
  });

  it('returns null when options array is empty', () => {
    const raw = JSON.stringify({ text: 'Q', options: [] });
    expect(parseMenuFileContent(raw)).toBeNull();
  });

  it('skips options with non-string labels', () => {
    const raw = JSON.stringify({ text: 'Q', options: [{ label: 42 }, { label: null }, { label: 'Valid' }] });
    const result = parseMenuFileContent(raw);
    expect(result!.inline_keyboard).toHaveLength(1);
    expect(result!.inline_keyboard[0][0].callback_data).toBe('choice:1');
  });

  it('returns null when all options have invalid labels', () => {
    const raw = JSON.stringify({ text: 'Q', options: [{ label: null }] });
    expect(parseMenuFileContent(raw)).toBeNull();
  });
});
