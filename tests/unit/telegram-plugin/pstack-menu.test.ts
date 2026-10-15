import { PSTACK_MENU_COMMAND, pstackMenuMarkup } from '../../../mcp/tools/telegram/pstack-menu';

// Dev e2e of #591: /pstack-setup on Telegram is a button menu the gateway renders.
test('builds the gateway screen and drops any button Telegram would reject', () => {
  const long = 'ps:m:1:' + 'x'.repeat(60);
  const menu = pstackMenuMarkup({ text: 'pstack setup', toast: 'y'.repeat(300), keyboard: [[{ text: 'On', data: 'ps:on' }, { text: 'Long', data: long }], [{ text: 'Other', data: 'model:x' }], [{ text: 'Close', data: 'ps:x' }]] });
  expect(menu.reply_markup.inline_keyboard).toEqual([[{ text: 'On', callback_data: 'ps:on' }], [{ text: 'Close', callback_data: 'ps:x' }]]);
  expect(menu.toast).toHaveLength(180);
  expect(menu.closed).toBe(false);
});

test('refuses a reply that is not a screen', () => {
  expect(() => pstackMenuMarkup({ success: true })).toThrow('INVALID_PSTACK_MENU');
});

test('both spellings open the menu only without arguments', () => {
  for (const text of ['/pstack-setup', '/pstack_setup', '/pstack_setup@claude_bot', '/pstack-setup  ']) expect(PSTACK_MENU_COMMAND.test(text)).toBe(true);
  for (const text of ['/pstack-setup on', '/pstack_setup bug-fix: claude-opus-5-5', '/pstack', '/pstack:why']) expect(PSTACK_MENU_COMMAND.test(text)).toBe(false);
});

// User request on #591: a final screen (Turn on/off) is shown as a result without buttons.
test('passes a final screen through as done', () => {
  expect(pstackMenuMarkup({ text: '✅ pstack is on for a.', keyboard: [], done: true })).toMatchObject({ done: true, closed: false });
  expect(pstackMenuMarkup({ text: 'pstack setup', keyboard: [] }).done).toBe(false);
});
