import { parseMenuFileContent } from '../../../mcp/tools/telegram/menu-parser';

describe('parseMenuFileContent', () => {
  it('parses a valid menu file into text + inline_keyboard with cancel button', () => {
    const raw = JSON.stringify({
      text: 'Pick an option:',
      options: [{ label: 'Alpha' }, { label: 'Beta' }, { label: 'Gamma' }],
    });
    const result = parseMenuFileContent(raw);
    expect(result).not.toBeNull();
    expect(result!.text).toBe('Pick an option:');
    // 3 option rows + 1 cancel row
    expect(result!.inline_keyboard).toHaveLength(4);
    expect(result!.inline_keyboard[0]).toEqual([{ text: '1. Alpha', callback_data: 'choice:1' }]);
    expect(result!.inline_keyboard[2]).toEqual([{ text: '3. Gamma', callback_data: 'choice:3' }]);
    // Cancel button is always appended as the last row
    expect(result!.inline_keyboard[3]).toEqual([{ text: '❌ Cancel', callback_data: 'menu:cancel' }]);
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
    // 1 valid option row + 1 cancel row
    expect(result!.inline_keyboard).toHaveLength(2);
    expect(result!.inline_keyboard[0][0].callback_data).toBe('choice:1');
    expect(result!.inline_keyboard[1][0].callback_data).toBe('menu:cancel');
  });

  it('returns null when all options have invalid labels', () => {
    const raw = JSON.stringify({ text: 'Q', options: [{ label: null }] });
    expect(parseMenuFileContent(raw)).toBeNull();
  });
});
