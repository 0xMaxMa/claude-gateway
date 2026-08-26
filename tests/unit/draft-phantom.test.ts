import { classifyPhantomDraft, unsubmittedDraft } from '../../src/shell/draft-phantom';
import { ScreenModel } from '../../src/shell/screen';

// Feed a screen and let xterm's async write buffer flush before reading text().
async function render(lines: string[]): Promise<ScreenModel> {
  const screen = new ScreenModel();
  screen.write(lines.join('\r\n'));
  await new Promise((r) => setTimeout(r, 40));
  return screen;
}
const FILLER = (n: number) => Array.from({ length: n }, (_, i) => `conversation line ${i}`);
const MENU_FOOTER = 'Enter to select · ↑/↓ to navigate · Esc to cancel';

describe('draft-phantom classifyPhantomDraft', () => {
  it('reports text no Ctrl+U in the budget could change as a phantom', () => {
    const menu = '1. First choice\n2. Second choice';
    expect(classifyPhantomDraft(menu, menu)).toBe(menu);
  });

  it('never reports a phantom once the input actually cleared', () => {
    expect(classifyPhantomDraft('some real draft', '')).toBeNull();
  });

  it('never reports a phantom when a Ctrl+U moved the text — a part-cleared draft is still real', () => {
    // Multi-line draft: the burst removed the tail but ran out of budget.
    expect(classifyPhantomDraft('line one\nline two\nline three', 'line one')).toBeNull();
  });
});

describe('draft-phantom unsubmittedDraft', () => {
  it('discounts a read byte-identical to the known phantom', () => {
    const menu = `1. First choice\n2. Second choice\n${MENU_FOOTER}`;
    expect(unsubmittedDraft(menu, menu)).toBe('');
  });

  it('passes a real draft through when no phantom was recorded', () => {
    expect(unsubmittedDraft('please run the deploy', null)).toBe('please run the deploy');
  });

  it('passes a menu-shaped USER draft through — #296 must not regress', () => {
    // The turn cleared normally, so no phantom was recorded. This draft looks
    // exactly like a menu; the swallowed-Enter retry must still see it, or the
    // turn wedges into the 30-min watchdog (#296 / PR #181 review round 2).
    expect(unsubmittedDraft('1. do the thing\n2. then the other', null)).toBe('1. do the thing\n2. then the other');
  });

  it('passes a draft through when it differs from the phantom, even by one character', () => {
    expect(unsubmittedDraft('1. First choice!', '1. First choice')).toBe('1. First choice!');
  });
});

describe('draft-phantom against a real ScreenModel (why the phantom exists)', () => {
  it('inputDraft() reports an interactive overlay as a draft, and the pair discounts it', async () => {
    const screen = await render([
      ...FILLER(18),
      'Which one?',
      '❯ 1. First choice',
      '  2. Second choice',
      MENU_FOOTER,
    ]);
    const seen = screen.inputDraft();
    // The reader cannot tell the overlay's caret row from the input box.
    expect(seen).not.toBe('');
    expect(seen).toContain('1. First choice');
    // Ctrl+U cannot edit a menu, so the burst leaves it byte-identical…
    const phantom = classifyPhantomDraft(seen, seen);
    expect(phantom).toBe(seen);
    // …and the submit-retry path stops reading it as unsubmitted text.
    expect(unsubmittedDraft(screen.inputDraft(), phantom)).toBe('');
  });

  it('a genuine draft in the input box is never discounted', async () => {
    const screen = await render([...FILLER(20), '❯ please run the deploy', '  Model: opus']);
    expect(screen.inputDraft()).toBe('please run the deploy');
    // Ctrl+U clears it, so clearInput() records no phantom.
    expect(unsubmittedDraft(screen.inputDraft(), null)).toBe('please run the deploy');
  });
});
