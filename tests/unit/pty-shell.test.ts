import { translateArgs, sanitizeUserText } from '../../src/shell/args';
import { projectSlug, transcriptPath, isSyntheticRequestTooLarge, TranscriptTailer } from '../../src/shell/tailer';
import {
  ScreenModel,
  TUI_BUSY_MARKER,
  TUI_BYPASS_PERMS,
  TUI_REQUEST_TOO_LARGE,
  TUI_REQUEST_TOO_LARGE_DISMISS,
  neutralizeTuiTriggers,
  parseMenuChoice,
  formatMenuPrompt,
  formatPermissionPrompt,
  extractChannelContent,
  isPtyActivelyWorking,
} from '../../src/shell/screen';
import { ProtocolEmitter } from '../../src/shell/emitter';
import { Writable } from 'stream';
import { preTrustWorkspace, checkAuthStatus } from '../../src/shell/trust';
import { decideMenuCancel, MenuCancelState } from '../../src/shell/menu-cancel';
import { decideProbeAttempt, confirmProbeReaction, ProbeState, PROBE_MAX_ROUNDS, PROBE_RETRY_COOLDOWN_MS } from '../../src/shell/menu-probe';
import {
  decideBypassDialogAction,
  isBypassDialogOnScreen,
  noteDialogAbsent,
  noteDialogPresent,
  rowPattern,
  BYPASS_KEY_DOWN,
  BYPASS_KEY_UP,
  BYPASS_KEY_ENTER,
  BYPASS_MAX_KEYS,
  BYPASS_RESET_AFTER_MISSES,
  BYPASS_ACCEPT_LABEL,
  BYPASS_DECLINE_LABEL,
  BYPASS_CONFIRM_FOOTER,
  BYPASS_HEADING,
} from '../../src/shell/bypass-dialog';
import { shouldAdoptOrphanWake, OrphanWakeObs } from '../../src/shell/orphan-wake';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

describe('pty-shell translateArgs', () => {
  const GATEWAY_ARGS = [
    '--mcp-config', '/tmp/mcp.json',
    '--model', 'claude-sonnet-4-6',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--print',
    '--verbose',
    '--dangerously-skip-permissions',
  ];

  it('consumes headless-only flags and passes the rest through', () => {
    const { claudeArgs, model } = translateArgs(GATEWAY_ARGS);
    expect(claudeArgs).not.toContain('--print');
    expect(claudeArgs).not.toContain('--verbose');
    expect(claudeArgs).not.toContain('--include-partial-messages');
    expect(claudeArgs).not.toContain('--input-format');
    expect(claudeArgs).not.toContain('--output-format');
    expect(claudeArgs).not.toContain('stream-json');
    expect(claudeArgs).toContain('--mcp-config');
    expect(claudeArgs).toContain('/tmp/mcp.json');
    expect(model).toBe('claude-sonnet-4-6');
  });

  it('always injects --dangerously-skip-permissions exactly once (built-in)', () => {
    // present in input → still exactly one
    const withFlag = translateArgs(GATEWAY_ARGS).claudeArgs;
    expect(withFlag.filter((a) => a === '--dangerously-skip-permissions')).toHaveLength(1);
    // absent from input → injected anyway
    const withoutFlag = translateArgs(GATEWAY_ARGS.slice(0, -1)).claudeArgs;
    expect(withoutFlag.filter((a) => a === '--dangerously-skip-permissions')).toHaveLength(1);
  });

  it('generates a session id and appends --session-id', () => {
    const { claudeArgs, sessionId } = translateArgs(GATEWAY_ARGS);
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const idx = claudeArgs.indexOf('--session-id');
    expect(idx).toBeGreaterThan(-1);
    expect(claudeArgs[idx + 1]).toBe(sessionId);
  });

  it('reuses a caller-provided --session-id', () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    const { sessionId, claudeArgs } = translateArgs([...GATEWAY_ARGS, '--session-id', uuid]);
    expect(sessionId).toBe(uuid);
    expect(claudeArgs.filter((a) => a === '--session-id')).toHaveLength(1);
  });

  it('rejects a non-UUID --session-id', () => {
    expect(() => translateArgs(['--session-id', '../../etc/passwd'])).toThrow(/not a UUID/);
  });

  it('passes unknown extraFlags through untouched', () => {
    const { claudeArgs } = translateArgs([...GATEWAY_ARGS, '--some-future-flag']);
    expect(claudeArgs).toContain('--some-future-flag');
  });
});

describe('pty-shell sanitizeUserText', () => {
  it('strips ESC and C0 control chars (terminal injection)', () => {
    expect(sanitizeUserText('hi\x1b[201~\rfake-enter\x07bell')).toBe('hi[201~\nfake-enterbell');
  });

  it('normalizes CRLF and lone CR to LF', () => {
    expect(sanitizeUserText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('keeps newlines, tabs, and unicode text', () => {
    expect(sanitizeUserText('สวัสดี\nline2\ttabbed')).toBe('สวัสดี\nline2\ttabbed');
  });
});

// Tests for TUI string constants — these catch Claude Code UI changes at the source.
// If Claude Code changes its TUI text, these tests will fail and remind you to update screen.ts.
describe('ScreenModel TUI constants (Claude Code v2.1.x)', () => {
  it('BUSY_MARKER is retained but documented best-effort (often absent on v2.1.227+)', () => {
    // The marker is kept as a fast supplementary hint (consumeBusySeen), but recent
    // Claude Code builds render a randomized gerund instead of "esc to interrupt",
    // so busy/turn detection must NOT depend on it — output-activity (quietMs) and
    // the transcript are authoritative. See the "no busy marker" liveness cases
    // below and the fallback-without-marker regression. This asserts the constant
    // still exists so screen.ts stays the single source of truth for the matcher.
    expect(typeof TUI_BUSY_MARKER).toBe('string');
    expect(TUI_BUSY_MARKER.length).toBeGreaterThan(0);
  });

  it('BYPASS_PERMS includes both expected dialog markers', () => {
    expect(TUI_BYPASS_PERMS).toContain('Bypass Permissions mode');
    expect(TUI_BYPASS_PERMS).toContain('Yes, I accept');
  });

  it('REQUEST_TOO_LARGE matches the recoverable 32MB error prefix', () => {
    expect(TUI_REQUEST_TOO_LARGE).toBe('Request too large (max');
  });

  it('REQUEST_TOO_LARGE_DISMISS matches the overlay dismiss footer', () => {
    expect(TUI_REQUEST_TOO_LARGE_DISMISS).toBe('esc to go back');
  });

});

describe('neutralizeTuiTriggers (history detox)', () => {
  const POISON =
    'Assistant: ...(กัน double-delete):Request too large (max 32MB). Double press esc to go back and try with a smaller file.';

  it('breaks both detector fragments in re-injected text', () => {
    const out = neutralizeTuiTriggers(POISON);
    expect(out).not.toContain(TUI_REQUEST_TOO_LARGE);        // 'Request too large (max'
    expect(out).not.toContain(TUI_REQUEST_TOO_LARGE_DISMISS); // 'esc to go back'
  });

  it('keeps the prose human-readable (only a space is inserted)', () => {
    const out = neutralizeTuiTriggers(POISON);
    expect(out).toContain('Request too large ( max 32MB)');
    expect(out).toContain('esc to go  back');
    expect(out).toContain('กัน double-delete'); // surrounding content untouched
  });

  it('is a no-op on text without the trigger fragments', () => {
    const clean = 'User: เปิด PR ให้หน่อย\nAssistant: ได้เลยค่ะ';
    expect(neutralizeTuiTriggers(clean)).toBe(clean);
  });

  it('handles empty input', () => {
    expect(neutralizeTuiTriggers('')).toBe('');
  });

  // Review round 2, finding M4. The bypass detector currently rejects re-injected
  // history because Claude Code paints the input box below it, failing the
  // "nothing below the footer" rule — but that is a fact about how Claude Code
  // renders, not an invariant we own, and the 32MB loop above is exactly the bug
  // that proved a footer-requirement guard insufficient against a verbatim copy.
  // Breaking the footer makes the bypass detector unreachable from re-injected
  // text by construction.
  it('breaks the bypass dialog footer so re-injected history cannot fake a dialog', async () => {
    const quoted = [
      'Assistant: the dialog that wedged the session looked like this:',
      '  WARNING: Claude Code running in Bypass Permissions mode',
      '  ❯ No, exit',
      '    Yes, I accept',
      '',
      '  Enter to confirm · Esc to cancel',
    ].join('\n');

    // Verbatim, this text is a detectable dialog when it owns the screen.
    const verbatimScreen = await renderScreen([
      ...quoted.split('\n'),
      ...Array.from({ length: 44 }, () => ''),
    ]);
    expect(verbatimScreen.detectDialog()).toBe('bypass-permissions');

    // After the detox it can never be, however it lands on screen.
    const detoxed = neutralizeTuiTriggers(quoted);
    expect(detoxed).not.toContain(BYPASS_CONFIRM_FOOTER);
    const detoxedScreen = await renderScreen([
      ...detoxed.split('\n'),
      ...Array.from({ length: 44 }, () => ''),
    ]);
    expect(detoxedScreen.detectDialog()).toBeNull();
  });
});

// consumeBusySeen is set synchronously from raw PTY bytes — no xterm async needed.
describe('ScreenModel raw-chunk busy detection', () => {
  it('consumeBusySeen is false initially', () => {
    const screen = new ScreenModel();
    expect(screen.consumeBusySeen()).toBe(false);
  });

  it('consumeBusySeen detects busy marker and is consumed after first read', () => {
    const screen = new ScreenModel();
    screen.write(TUI_BUSY_MARKER);
    expect(screen.consumeBusySeen()).toBe(true);
    expect(screen.consumeBusySeen()).toBe(false); // one-shot flag
  });

  it('consumeBusySeen detects marker embedded in surrounding text', () => {
    const screen = new ScreenModel();
    screen.write(`spinner ${TUI_BUSY_MARKER} 42s`);
    expect(screen.consumeBusySeen()).toBe(true);
  });

  it('consumeBusySeen returns false when marker is absent', () => {
    const screen = new ScreenModel();
    screen.write('idle prompt text without the marker');
    expect(screen.consumeBusySeen()).toBe(false);
  });

  it('quietMs grows after a write', async () => {
    const screen = new ScreenModel();
    screen.write('hello');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.quietMs()).toBeGreaterThanOrEqual(40);
  });
});

describe('isPtyActivelyWorking (heartbeat liveness)', () => {
  const LIVENESS = 45_000; // mirrors HEARTBEAT_LIVENESS_QUIET_MS in claude-pty-shell.ts

  it('alive when the busy spinner is on screen (fast path)', () => {
    // Busy marker present → alive regardless of quietMs.
    expect(isPtyActivelyWorking({ isBusy: true, quietMs: 999_999 }, LIVENESS)).toBe(true);
  });

  it('alive when the PTY emitted output recently (no busy marker)', () => {
    // The core fix: compaction / large-request assembly / sub-agent runs drop the
    // "esc to interrupt" marker (isBusy=false) but keep animating → quietMs stays low.
    // This must hold even though recent Claude Code keeps the ❯ input caret on screen
    // for queueing during a turn — hence NO hasPrompt gate.
    expect(isPtyActivelyWorking({ isBusy: false, quietMs: 1_000 }, LIVENESS)).toBe(true);
  });

  it('NOT alive when genuinely quiet for longer than the liveness window (hung/idle)', () => {
    // No spinner, no recent output → a settled idle prompt or a genuine hang. Both go
    // quiet, so quietMs grows past the window and the receiver's stalled detector fires.
    expect(isPtyActivelyWorking({ isBusy: false, quietMs: 60_000 }, LIVENESS)).toBe(false);
  });

  it('liveness window is a strict bound (quietMs === window is NOT alive)', () => {
    expect(isPtyActivelyWorking({ isBusy: false, quietMs: LIVENESS }, LIVENESS)).toBe(false);
    expect(isPtyActivelyWorking({ isBusy: false, quietMs: LIVENESS - 1 }, LIVENESS)).toBe(true);
  });
});

// Feed a screen and let xterm's async write buffer flush before reading text().
async function renderScreen(lines: string[]): Promise<ScreenModel> {
  const screen = new ScreenModel();
  screen.write(lines.join('\r\n'));
  await new Promise((r) => setTimeout(r, 30));
  return screen;
}

const MENU_FOOTER = 'Enter to select · ↑/↓ to navigate · Esc to cancel';
// Pushes real content above the bottom-region window (DIALOG_REGION_ROWS) so tests
// can assert region-restricted behavior against realistic scrollback.
const FILLER = (n: number) => Array.from({ length: n }, (_, i) => `conversation line ${i}`);

describe('ScreenModel readInteractivePrompt (plain AskUserQuestion-style menu)', () => {
  it('parses numbered options (with ❯ highlight + a divider), classified as a plain menu', async () => {
    const screen = await renderScreen([
      'Which option do you want?',
      '',
      '❯ 1. First choice',
      '  2. Second choice',
      '  3. Third choice',
      '  ─────────────',
      '  4. Chat about this',
      '',
      MENU_FOOTER,
    ]);
    const prompt = screen.readInteractivePrompt();
    expect(prompt).not.toBeNull();
    expect(prompt!.isPermission).toBe(false);
    expect(prompt!.options.map((o) => o.index)).toEqual([1, 2, 3, 4]);
    expect(prompt!.options[0].label).toBe('First choice');
    expect(prompt!.options[3].label).toBe('Chat about this');
    expect(prompt!.highlighted).toBe(1);
  });

  it('ignores stale numbered scrollback above the live menu', async () => {
    // Reproduces the live bug: a prior chat message rendered as "1. … 2. …"
    // sat in scrollback above an AskUserQuestion menu, so a naive scan would
    // sweep the phantom rows in — inflating the option list and shifting
    // every index. readInteractivePrompt() takes only the live 1..N run
    // nearest the end of the buffer.
    const screen = await renderScreen([
      '1. restart gateway now',
      '2. restart drops the running session',
      '',
      'Which option do you want?',
      '',
      '❯ 1. See the buttons',
      '  2. Type the number',
      '  3. Nothing showed up',
      '',
      MENU_FOOTER,
    ]);
    const prompt = screen.readInteractivePrompt();
    expect(prompt).not.toBeNull();
    expect(prompt!.options.map((o) => o.index)).toEqual([1, 2, 3]);
    expect(prompt!.options[0].label).toBe('See the buttons');
    expect(prompt!.options.map((o) => o.label)).not.toContain('restart gateway now');
  });

  it('returns null for plain prose with no live numbered-option run (no caret, no live UI)', async () => {
    const screen = await renderScreen([
      'Here is a numbered list in normal output:',
      '1. not a menu',
      '2. still not a menu',
    ]);
    expect(screen.readInteractivePrompt()).toBeNull();
  });

  it('returns null for a markdown blockquote numbered list — ASCII ">" is not a selection caret', async () => {
    // The fake-menu bug from the PR #181 review (F1): quoted prose like
    // "> 1. …" satisfied the old [❯>] caret alternation, so an Up-recall
    // screen change plus this static text bridged a fabricated menu. The
    // caret gate is now U+276F only — the real TUI never renders ">".
    const screen = await renderScreen([
      'The user asked earlier:',
      '> 1. First choice',
      '> 2. Second choice',
      '',
      '❯ ',
    ]);
    expect(screen.readInteractivePrompt()).toBeNull();
  });

  it('reports which option the caret highlights (probe compares this across snapshots)', async () => {
    const screen = await renderScreen([
      'Which option do you want?',
      '',
      '  1. First choice',
      '❯ 2. Second choice',
      '  3. Third choice',
      '',
      MENU_FOOTER,
    ]);
    expect(screen.readInteractivePrompt()!.highlighted).toBe(2);
  });

  it('returns null with fewer than two options', async () => {
    const screen = await renderScreen([
      'Confirm?',
      '  1. Only choice',
      MENU_FOOTER,
    ]);
    expect(screen.readInteractivePrompt()).toBeNull();
  });

  it('reads the highlight from the run\'s own rows — a caret-bearing input line cannot supply it (round-2 finding 2)', async () => {
    // The recall-forgery hole: a static quoted menu sits in scrollback and the
    // probe's Up fallback recalls a history entry beginning "2." — the input
    // line renders as "❯ 2. …", a perfectly caret-shaped option row. A
    // whole-screen caret scan read the highlight from that bottom-most row
    // (1→2 = "moved") and bridged a fabricated menu. The highlight must come
    // from the selected 1..N run itself, where the caret is still on row 1.
    const screen = await renderScreen([
      'Earlier the assistant quoted a menu verbatim:',
      '❯ 1. First choice',
      '  2. Second choice',
      '',
      '❯ 2. remove the old files',
    ]);
    const prompt = screen.readInteractivePrompt();
    expect(prompt).not.toBeNull();
    expect(prompt!.options.map((o) => o.index)).toEqual([1, 2]);
    expect(prompt!.highlighted).toBe(1); // NOT 2 from the input line
  });

  it('the recall-forgery screen pair never satisfies confirmProbeReaction (highlight did not move)', async () => {
    // End-to-end shape of the round-2 finding-2 exploit: before = quoted menu
    // + idle input, after = same menu + recalled "2. …" in the input line.
    // Both parse, both highlight row 1 → no move → no bridge.
    const before = await renderScreen([
      'Earlier the assistant quoted a menu verbatim:',
      '❯ 1. First choice',
      '  2. Second choice',
      '',
      '❯ ',
    ]);
    const after = await renderScreen([
      'Earlier the assistant quoted a menu verbatim:',
      '❯ 1. First choice',
      '  2. Second choice',
      '',
      '❯ 2. remove the old files',
    ]);
    expect(confirmProbeReaction(before.readInteractivePrompt(), after.readInteractivePrompt())).toBe(false);
  });

  it('returns null when the run carries two highlights (a caret line joined the run)', async () => {
    // A recalled entry beginning "3." EXTENDS a static [1,2] run into [1,2,3]
    // and brings a second caret with it — a live menu highlights exactly one
    // of its rows, so anything else is not a live menu.
    const screen = await renderScreen([
      '❯ 1. First choice',
      '  2. Second choice',
      '❯ 3. do the third thing',
    ]);
    expect(screen.readInteractivePrompt()).toBeNull();
  });

  it('captures the question text above the options as context (bug: bare "Choose an option" in chat)', async () => {
    // Without the context, the bridged Telegram message is an option list
    // with no question — the user cannot tell what is being asked.
    const screen = await renderScreen([
      'Scope of the PR',
      '',
      'Should the fix cover only the 3 failing suites, or the whole repo?',
      '',
      '❯ 1. Only the 3 suites',
      '  2. Whole-repo sweep',
      '  3. Chat about this',
      '',
      MENU_FOOTER,
    ]);
    const prompt = screen.readInteractivePrompt();
    expect(prompt).not.toBeNull();
    expect(prompt!.context).toContain('Scope of the PR');
    expect(prompt!.context).toContain('whole repo?');
    // The footer/options themselves are not part of the context.
    expect(prompt!.context).not.toContain('1. Only the 3 suites');
  });

  it('bounds the context at the question box top border', async () => {
    // The question header can render inside a rounded box above the option
    // rows — the border marks where the question starts, so scrollback above
    // it must not leak into the context.
    const screen = await renderScreen([
      'unrelated earlier conversation output',
      '╭──────────────────────────────╮',
      '│ Pick a database              │',
      '╰──────────────────────────────╯',
      '❯ 1. Postgres',
      '  2. SQLite',
      '',
      MENU_FOOTER,
    ]);
    const prompt = screen.readInteractivePrompt();
    expect(prompt).not.toBeNull();
    expect(prompt!.context).toContain('Pick a database');
    expect(prompt!.context).not.toContain('unrelated earlier conversation');
  });

  it('plan-approval shape: proceed question and plan tail become the context', async () => {
    // The plan-mode approval prompt is unboxed: prose (the plan) ends with
    // "Would you like to proceed?" directly above the option run.
    const screen = await renderScreen([
      'Here is Claude\'s plan:',
      'Fix the flaky sleeps in the three failing suites.',
      '',
      'Would you like to proceed?',
      '',
      '❯ 1. Yes, and bypass permissions',
      '  2. Yes, manually approve edits',
      '  3. Tell Claude what to change',
      '',
      MENU_FOOTER,
    ]);
    const prompt = screen.readInteractivePrompt();
    expect(prompt).not.toBeNull();
    expect(prompt!.context).toContain('Would you like to proceed?');
    expect(prompt!.context).toContain('flaky sleeps');
  });

  it('caps oversized context, keeping the tail nearest the options', async () => {
    const longLines = Array.from({ length: 12 }, (_, i) => `plan detail line ${i} ${'x'.repeat(150)}`);
    const screen = await renderScreen([
      ...longLines,
      'Would you like to proceed?',
      '❯ 1. Yes',
      '  2. No',
      MENU_FOOTER,
    ]);
    const prompt = screen.readInteractivePrompt();
    expect(prompt).not.toBeNull();
    expect(prompt!.context.length).toBeLessThanOrEqual(1201); // cap + leading ellipsis
    expect(prompt!.context).toContain('Would you like to proceed?'); // tail survives
  });
});

describe('hasPrompt() vs interactivePromptBlocking() (menu-caret false-positive)', () => {
  // hasPrompt()'s idle-prompt regex (`/^❯ /m`) scans the whole visible screen
  // and cannot tell the real idle caret apart from a highlighted menu option
  // row, which uses the exact same `❯` marker flush at column 0.
  // interactivePromptBlocking() is the DELIBERATELY PERMISSIVE companion scan
  // (see its doc): it gates only actions where a false positive is cheap —
  // the confirming Enter after a typed selection, decideMenuCancel's
  // menuVisible, and the Enter-swallowed retry of a MENU-SELECTION turn. An
  // ordinary turn's retry is NOT gated on it (the unsubmitted draft itself
  // renders "❯ <text>" and would suppress the retry — round-2 finding 1).

  it('a highlighted menu option row satisfies hasPrompt() (documents the collision), and interactivePromptBlocking() is also true on the same screen', async () => {
    const screen = await renderScreen([
      ...FILLER(44),
      'Which option do you want?',
      '',
      '❯ 1. First choice',
      '  2. Second choice',
      '',
      MENU_FOOTER,
    ]);
    expect(screen.hasPrompt()).toBe(true);
    expect(screen.interactivePromptBlocking()).toBe(true);
  });

  it('a genuinely idle bash prompt has hasPrompt() true and interactivePromptBlocking() false', async () => {
    const screen = await renderScreen([
      ...FILLER(44),
      'Done.',
      '❯ ',
    ]);
    expect(screen.hasPrompt()).toBe(true);
    expect(screen.interactivePromptBlocking()).toBe(false);
  });

  it('sees a menu sitting HIGH on a sparse screen (full-viewport scan — F4)', async () => {
    // A fresh session renders the menu near the top of the viewport. The old
    // bottom-20-rows window missed it, so selectMenuOption() skipped the
    // confirming Enter and the selection hung.
    const screen = await renderScreen([
      'Which option do you want?',
      '❯ 1. First choice',
      '  2. Second choice',
      '',
      MENU_FOOTER,
    ]);
    expect(screen.interactivePromptBlocking()).toBe(true);
  });

  it('markdown blockquote prose ("> 1.") anywhere on screen is not a blocking prompt', async () => {
    // The full-viewport scan is only safe because ASCII ">" no longer counts
    // as a caret — otherwise every quoted numbered list would suppress the
    // Enter-swallowed retry and inject stray Enters after menu selections.
    const screen = await renderScreen([
      'The user asked:',
      '> 1. First choice',
      '> 2. Second choice',
      ...FILLER(40),
      '❯ ',
    ]);
    expect(screen.interactivePromptBlocking()).toBe(false);
  });
});

describe('parseMenuChoice', () => {
  it('accepts a leading integer within range', () => {
    expect(parseMenuChoice('1', 4)).toBe(1);
    expect(parseMenuChoice('2.', 4)).toBe(2);
    expect(parseMenuChoice('  3 pick this', 4)).toBe(3);
  });

  it('rejects non-numbers and out-of-range values', () => {
    expect(parseMenuChoice('abc', 5)).toBeNull();
    expect(parseMenuChoice('', 5)).toBeNull();
    expect(parseMenuChoice('0', 5)).toBeNull();
    expect(parseMenuChoice('9', 5)).toBeNull();
  });
});

describe('extractChannelContent', () => {
  it('unwraps a channel envelope so a menu reply parses as the bare choice', () => {
    const xml = '<channel source="telegram" chat_id="997170033" message_id="42" user="boss" ts="2026-06-14T00:00:00.000Z">1</channel>';
    expect(extractChannelContent(xml)).toBe('1');
    // Regression: the whole reason taps/typed numbers failed — the envelope
    // starts with "<", so parseMenuChoice on the raw XML returns null.
    expect(parseMenuChoice(xml, 4)).toBeNull();
    expect(parseMenuChoice(extractChannelContent(xml), 4)).toBe(1);
  });

  it('strips a nested <replied> block before the user content', () => {
    const xml = '<channel source="discord" chat_id="9" message_id="1" user="u" ts="t"><replied message_id="7" user="bot">3. Pick C</replied>2</channel>';
    expect(extractChannelContent(xml)).toBe('2');
  });

  it('returns plain text unchanged (raw API / typed reply)', () => {
    expect(extractChannelContent('2')).toBe('2');
    expect(extractChannelContent('  3 ')).toBe('  3 ');
  });

  it('ignores numeric noise in envelope attributes (chat_id, ts)', () => {
    const xml = '<channel source="telegram" chat_id="997170033" ts="2026-06-14">4</channel>';
    expect(extractChannelContent(xml)).toBe('4');
    expect(parseMenuChoice(extractChannelContent(xml), 5)).toBe(4);
  });
});

describe('formatMenuPrompt', () => {
  it('renders a numbered list with the reply instruction', () => {
    const text = formatMenuPrompt([{ index: 1, label: 'Alpha' }, { index: 2, label: 'Beta' }]);
    expect(text).toContain('1. Alpha');
    expect(text).toContain('2. Beta');
    expect(text.toLowerCase()).toContain('reply with the number');
  });

  it('leads with the question context when provided', () => {
    const text = formatMenuPrompt(
      [{ index: 1, label: 'Alpha' }, { index: 2, label: 'Beta' }],
      'Scope of the PR\n\nWhich scope should the fix cover?',
    );
    expect(text.indexOf('Scope of the PR')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Scope of the PR')).toBeLessThan(text.indexOf('1. Alpha'));
    expect(text).toContain('Which scope should the fix cover?');
  });

  it('omits the context block when empty (unchanged legacy shape)', () => {
    const text = formatMenuPrompt([{ index: 1, label: 'Alpha' }, { index: 2, label: 'Beta' }], '');
    expect(text.startsWith('🔢')).toBe(true);
  });
});

describe('preTrustWorkspace', () => {
  let tmpDir: string;
  let claudeJsonPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-trust-test-'));
    claudeJsonPath = path.join(tmpDir, '.claude.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates ~/.claude.json with all flags when file absent', () => {
    preTrustWorkspace('/workspace/test', claudeJsonPath);
    const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    expect(data.projects['/workspace/test'].hasTrustDialogAccepted).toBe(true);
    expect(data.projects['/workspace/test'].projectOnboardingSeenCount).toBe(1);
    expect(data.hasCompletedOnboarding).toBe(true);
  });

  it('adds flags to existing file without overwriting other data', () => {
    fs.writeFileSync(claudeJsonPath, JSON.stringify({ userID: 'abc123', projects: { '/other': { foo: 'bar' } } }));
    preTrustWorkspace('/workspace/new', claudeJsonPath);
    const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    expect(data.userID).toBe('abc123');
    expect(data.projects['/other'].foo).toBe('bar');
    expect(data.projects['/workspace/new'].hasTrustDialogAccepted).toBe(true);
    expect(data.projects['/workspace/new'].projectOnboardingSeenCount).toBe(1);
    expect(data.hasCompletedOnboarding).toBe(true);
  });

  it('skips write when all flags already set', () => {
    fs.writeFileSync(claudeJsonPath, JSON.stringify({
      hasCompletedOnboarding: true,
      projects: { '/ws': { hasTrustDialogAccepted: true, projectOnboardingSeenCount: 1 } },
    }));
    const mtime = fs.statSync(claudeJsonPath).mtimeMs;
    preTrustWorkspace('/ws', claudeJsonPath);
    expect(fs.statSync(claudeJsonPath).mtimeMs).toBe(mtime);
  });

  it('writes when project flags set but global flags missing', () => {
    fs.writeFileSync(claudeJsonPath, JSON.stringify({
      projects: { '/ws': { hasTrustDialogAccepted: true, projectOnboardingSeenCount: 1 } },
    }));
    preTrustWorkspace('/ws', claudeJsonPath);
    const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    expect(data.hasCompletedOnboarding).toBe(true);
  });

  it('writes when hasTrustDialogAccepted set but projectOnboardingSeenCount missing', () => {
    fs.writeFileSync(claudeJsonPath, JSON.stringify({ projects: { '/ws': { hasTrustDialogAccepted: true } } }));
    preTrustWorkspace('/ws', claudeJsonPath);
    const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    expect(data.projects['/ws'].projectOnboardingSeenCount).toBe(1);
  });

  it('sets trust when project entry exists but flags are missing', () => {
    fs.writeFileSync(claudeJsonPath, JSON.stringify({ projects: { '/ws': { someOtherKey: 1 } } }));
    preTrustWorkspace('/ws', claudeJsonPath);
    const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    expect(data.projects['/ws'].hasTrustDialogAccepted).toBe(true);
    expect(data.projects['/ws'].projectOnboardingSeenCount).toBe(1);
    expect(data.projects['/ws'].someOtherKey).toBe(1);
  });

  it('handles malformed ~/.claude.json gracefully', () => {
    fs.writeFileSync(claudeJsonPath, 'not valid json');
    expect(() => preTrustWorkspace('/ws', claudeJsonPath)).not.toThrow();
    const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    expect(data.projects['/ws'].hasTrustDialogAccepted).toBe(true);
    expect(data.projects['/ws'].projectOnboardingSeenCount).toBe(1);
    expect(data.hasCompletedOnboarding).toBe(true);
  });
});

describe('checkAuthStatus', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns loggedIn=false when binary does not exist', () => {
    expect(checkAuthStatus('/nonexistent/claude-binary').loggedIn).toBe(false);
  });

  it('returns loggedIn=false when binary exits non-zero', () => {
    expect(checkAuthStatus('false').loggedIn).toBe(false);
  });

  it('returns loggedIn=false when binary outputs invalid JSON', () => {
    // echo outputs its args ("auth status") which is not valid JSON
    expect(checkAuthStatus('echo').loggedIn).toBe(false);
  });

  it('returns loggedIn=true and authMethod when binary outputs valid JSON', () => {
    const script = path.join(tmpDir, 'fake-claude.sh');
    fs.writeFileSync(script, '#!/bin/sh\necho \'{"loggedIn":true,"authMethod":"oauth"}\'\n');
    fs.chmodSync(script, 0o755);
    const result = checkAuthStatus(script);
    expect(result.loggedIn).toBe(true);
    expect(result.authMethod).toBe('oauth');
  });

  it('returns loggedIn=false when JSON has loggedIn=false', () => {
    const script = path.join(tmpDir, 'fake-claude-unauth.sh');
    fs.writeFileSync(script, '#!/bin/sh\necho \'{"loggedIn":false}\'\n');
    fs.chmodSync(script, 0o755);
    expect(checkAuthStatus(script).loggedIn).toBe(false);
  });
});

describe('pty-shell transcript path', () => {
  it('slugifies cwd the way Claude Code does (/ and . become -)', () => {
    expect(projectSlug('/tmp/pty-poc')).toBe('-tmp-pty-poc');
    expect(projectSlug('/home/ubuntu/.claude-gateway/agents/x/workspace'))
      .toBe('-home-ubuntu--claude-gateway-agents-x-workspace');
  });

  it('builds the transcript path under ~/.claude/projects', () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    expect(transcriptPath('/tmp/pty-poc', uuid))
      .toBe(`${os.homedir()}/.claude/projects/-tmp-pty-poc/${uuid}.jsonl`);
  });
});

describe('TranscriptTailer onToolResult (main-chain tool_result only)', () => {
  let sessionId: string;
  let file: string;
  let tailer: TranscriptTailer | null;

  beforeEach(() => {
    sessionId = '99999999-8888-7777-6666-' + Date.now().toString().padStart(12, '0');
    file = transcriptPath(process.cwd(), sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    tailer = null;
  });

  afterEach(() => {
    tailer?.stop();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });

  function makeTailer(onToolResult: (id: string) => void): TranscriptTailer {
    tailer = new TranscriptTailer(process.cwd(), sessionId, {
      onAssistant: () => {},
      onTurnEnd: () => {},
      onToolResult,
      onError: (err) => { throw err; },
    });
    return tailer;
  }

  it('fires for a non-sidechain tool_result block (main-chain tool resolved)', () => {
    const seen: string[] = [];
    const t = makeTailer((id) => seen.push(id));
    fs.appendFileSync(file, JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'abc-123' }] },
    }) + '\n');
    t.flush();
    expect(seen).toEqual(['abc-123']);
  });

  it('does not fire for a sidechain tool_result (a sub-agent\'s own tool call)', () => {
    const seen: string[] = [];
    const t = makeTailer((id) => seen.push(id));
    fs.appendFileSync(file, JSON.stringify({
      type: 'user',
      isSidechain: true,
      message: { content: [{ type: 'tool_result', tool_use_id: 'sub-456' }] },
    }) + '\n');
    t.flush();
    expect(seen).toEqual([]);
  });

  it('ignores plain user text records (no tool_result content)', () => {
    const seen: string[] = [];
    const t = makeTailer((id) => seen.push(id));
    fs.appendFileSync(file, JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'text', text: 'hello' }] },
    }) + '\n');
    t.flush();
    expect(seen).toEqual([]);
  });
});

describe('TranscriptTailer onToolUse (main-chain tool_use, with name)', () => {
  let sessionId: string;
  let file: string;
  let tailer: TranscriptTailer | null;

  beforeEach(() => {
    sessionId = '99999999-8888-7777-5555-' + Date.now().toString().padStart(12, '0');
    file = transcriptPath(process.cwd(), sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    tailer = null;
  });

  afterEach(() => {
    tailer?.stop();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });

  function makeTailer(onToolUse: (id: string, name: string) => void): TranscriptTailer {
    tailer = new TranscriptTailer(process.cwd(), sessionId, {
      onAssistant: () => {},
      onTurnEnd: () => {},
      onToolUse,
      onError: (err) => { throw err; },
    });
    return tailer;
  }

  it('fires with (id, name) for a non-sidechain assistant tool_use block', () => {
    const seen: Array<[string, string]> = [];
    const t = makeTailer((id, name) => seen.push([id, name]));
    fs.appendFileSync(file, JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'task-1', name: 'Task', input: {} }] },
    }) + '\n');
    t.flush();
    expect(seen).toEqual([['task-1', 'Task']]);
  });

  it('does not fire for a sidechain assistant tool_use (sub-agent internal call)', () => {
    const seen: Array<[string, string]> = [];
    const t = makeTailer((id, name) => seen.push([id, name]));
    fs.appendFileSync(file, JSON.stringify({
      type: 'assistant',
      isSidechain: true,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'inner-1', name: 'Bash', input: {} }] },
    }) + '\n');
    t.flush();
    expect(seen).toEqual([]);
  });

  it('reports the real tool name so non-Task tools can be distinguished', () => {
    const seen: Array<[string, string]> = [];
    const t = makeTailer((id, name) => seen.push([id, name]));
    fs.appendFileSync(file, JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b-1', name: 'Bash', input: {} }] },
    }) + '\n');
    t.flush();
    expect(seen).toEqual([['b-1', 'Bash']]);
  });
});

// Verbatim captures of the real dialog, taken by driving
// `claude --dangerously-skip-permissions` through node-pty + @xterm/headless
// and reading the screen with no keys pressed. The ONLY difference between the
// row variants is the option rows: Claude Code <= 2.1.247 numbers them,
// >= 2.1.248 does not (bisected to that exact release — issue #431). Both start
// with the caret on "No, exit".
const DIALOG_BODY = [
  '  WARNING: Claude Code running in Bypass Permissions mode',
  '',
  '  In Bypass Permissions mode, Claude Code will not ask for your approval before running',
  '  potentially dangerous commands.',
  '  This mode should only be used in a sandboxed container/VM that has restricted internet access',
  '  and can easily be restored if damaged.',
  '',
  '  By proceeding, you accept all responsibility for actions taken while running in Bypass',
  '  Permissions mode.',
  '',
  '  https://code.claude.com/docs/en/security',
  '',
];
const DIALOG_FOOTER = ['', '  Enter to confirm · Esc to cancel'];
// The modal with scrollback above it and nothing below — the shape a session
// that had already produced output shows. 34 + 12 + 2 + 2 = exactly 50 rows.
const dialog = (rows: string[]) => [...FILLER(34), ...DIALOG_BODY, ...rows, ...DIALOG_FOOTER];

/** Claude Code <= 2.1.247 — numbered rows, caret on decline. */
const LEGACY_ROWS = ['  ❯ 1. No, exit', '    2. Yes, I accept'];
/** Claude Code >= 2.1.248 — no row numbers, caret on decline. */
const CURRENT_ROWS = ['  ❯ No, exit', '    Yes, I accept'];
/** The same build after one Down: caret has moved onto the accept row. */
const CURRENT_ROWS_AFTER_DOWN = ['    No, exit', '  ❯ Yes, I accept'];

/**
 * Issue #436, verbatim: the 50-row screen a session was killed on after its
 * 120 s startup timeout, recovered from the driver's own timeout dump. This is
 * what the dialog looks like on a CLEAN boot — it renders at the TOP, because
 * there is no conversation yet to push it down, and rows 16-50 are blank.
 *
 * The old detector scanned the bottom 20 rows (31-50) and so matched nothing at
 * all here: no keystroke was sent, the startup timeout fired, the session
 * respawned into the same dialog.
 */
const TOP_OF_SCREEN_CAPTURE = [
  '',
  '─'.repeat(185),
  '  WARNING: Claude Code running in Bypass Permissions mode',
  '',
  '  In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.',
  '  This mode should only be used in a sandboxed container/VM that has restricted internet access and can easily be restored if damaged.',
  '',
  '  By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.',
  '',
  '  https://code.claude.com/docs/en/security',
  '',
  '  ❯ No, exit',
  '    Yes, I accept',
  '',
  '  Enter to confirm · Esc to cancel',
  ...Array.from({ length: 35 }, () => ''),
];

describe('ScreenModel detectDialog (structural, not positional)', () => {
  it('detects the dialog at the TOP of an otherwise blank screen (issue #436 regression)', async () => {
    // Fails on the pre-fix code: both markers sit at rows 3-13, the detector
    // scanned rows 31-50, and every one of those rows is blank.
    const screen = await renderScreen(TOP_OF_SCREEN_CAPTURE);
    expect(screen.detectDialog()).toBe('bypass-permissions');
  });

  it('still detects the dialog when scrollback has pushed it to the bottom', async () => {
    const screen = await renderScreen(dialog(CURRENT_ROWS));
    expect(screen.detectDialog()).toBe('bypass-permissions');
  });

  it('detects the numbered rendering in both positions too (<= 2.1.247)', async () => {
    expect((await renderScreen(dialog(LEGACY_ROWS))).detectDialog()).toBe('bypass-permissions');
    const top = [...DIALOG_BODY, ...LEGACY_ROWS, ...DIALOG_FOOTER];
    expect((await renderScreen(top)).detectDialog()).toBe('bypass-permissions');
  });

  it('ignores prose that merely quotes the markers', async () => {
    const screen = await renderScreen([
      'Assistant: ตอน "Bypass Permissions mode" โผล่ มันจะให้กด "Yes, I accept"',
      ...FILLER(44),
      '❯ ',
    ]);
    expect(screen.detectDialog()).toBeNull();
    // Sanity: the markers ARE on screen — the structural test is what excludes
    // them, and it no longer depends on WHERE on the screen they landed.
    expect(screen.text()).toContain('Bypass Permissions mode');
    expect(screen.text()).toContain('Yes, I accept');
  });

  it('requires BOTH markers (one alone never triggers)', async () => {
    const screen = await renderScreen([...FILLER(45), '  Bypass Permissions mode']);
    expect(screen.detectDialog()).toBeNull();
  });

  it('ignores a dialog that has scrolled up with live content below it', async () => {
    // The property that replaced the bottom-region window: a live modal OWNS
    // the screen. Anything rendered below its footer — conversation lines, an
    // idle input caret — means what is on screen is a record of a dialog, not
    // one we can drive.
    const screen = await renderScreen([...dialog(CURRENT_ROWS_AFTER_DOWN), ...FILLER(44), '❯ ']);
    expect(screen.detectDialog()).toBeNull();
  });

  it('ignores the dialog while no row is highlighted (frame still rendering)', async () => {
    const screen = await renderScreen(dialog(['    No, exit', '    Yes, I accept']));
    expect(screen.detectDialog()).toBeNull();
  });

  it('ignores a shape with a caret on both rows', async () => {
    const screen = await renderScreen(dialog(['  ❯ No, exit', '  ❯ Yes, I accept']));
    expect(screen.detectDialog()).toBeNull();
  });

  it('requires the confirm footer below the option rows', async () => {
    // Without its own affordance the rows are just two lines of text. The
    // footer is also what the accepting Enter relies on, so detection and the
    // action stay gated on the same evidence.
    const screen = await renderScreen([...FILLER(34), ...DIALOG_BODY, ...CURRENT_ROWS, '', '']);
    expect(screen.detectDialog()).toBeNull();
  });

  it('ignores a footer that renders above the option rows', async () => {
    const screen = await renderScreen([...FILLER(34), ...DIALOG_BODY, ...DIALOG_FOOTER, ...CURRENT_ROWS]);
    expect(screen.detectDialog()).toBeNull();
  });

  it('is a pure function of the screen text (same verdict, no ScreenModel)', async () => {
    const screen = await renderScreen(TOP_OF_SCREEN_CAPTURE);
    expect(isBypassDialogOnScreen(screen.text())).toBe(true);
    expect(isBypassDialogOnScreen(screen.text().replace(BYPASS_CONFIRM_FOOTER, 'Enter to  confirm'))).toBe(false);
  });

  // Review round 2, finding H1. The heading check used to live in detectDialog()
  // rather than in the predicate, so decideBypassDialogAction() — which re-applies
  // the predicate to refuse acting on a non-dialog — enforced only half the rule.
  // A screen with a perfect dialog SHAPE but no heading therefore produced a live
  // Enter at the action layer while the detector said null. The rule is one
  // predicate now, and this pins both layers to it.
  it('requires the heading, so the detect and act layers cannot drift (H1)', async () => {
    const shapeWithoutHeading = [
      'Assistant: after you press Down the screen looks like:',
      '',
      ...CURRENT_ROWS_AFTER_DOWN,
      ...DIALOG_FOOTER,
      ...Array.from({ length: 44 }, () => ''),
    ];
    const screen = await renderScreen(shapeWithoutHeading);
    expect(screen.text()).not.toContain('Bypass Permissions mode');
    expect(isBypassDialogOnScreen(screen.text())).toBe(false);
    expect(screen.detectDialog()).toBeNull();
    // The layer that actually emits keystrokes must refuse too — this is the
    // assertion that would have caught the drift.
    expect(decideBypassDialogAction(screen.dialogText(), { keys: 0, misses: 0 })).toEqual({
      kind: 'wait',
      reason: 'no live bypass dialog on screen',
    });
  });

  // Review round 2, finding M3. Before the gap bounds, the "structure" was only
  // an ordering: the elements never had to belong to the same visual block, so
  // three lines scattered down a screen of ordinary conversation qualified — and
  // yielded a real `confirm`.
  it('requires the rows and footer to be one block, not merely in order (M3)', async () => {
    const scattered = [
      'WARNING: Claude Code running in Bypass Permissions mode',
      ...Array.from({ length: 5 }, () => 'noise'),
      '    No, exit',
      ...Array.from({ length: 15 }, () => 'unrelated conversation text'),
      '  ❯ Yes, I accept',
      ...Array.from({ length: 10 }, () => 'more unrelated text'),
      '  press Enter to confirm your subscription',
      ...Array.from({ length: 17 }, () => ''),
    ];
    const screen = await renderScreen(scattered);
    expect(isBypassDialogOnScreen(screen.text())).toBe(false);
    expect(screen.detectDialog()).toBeNull();
    expect(decideBypassDialogAction(screen.dialogText(), { keys: 0, misses: 0 })).toEqual({
      kind: 'wait',
      reason: 'no live bypass dialog on screen',
    });
  });

  // Review round 2, finding M2 — accepted as accurate, resolved by DOCUMENTING
  // the trade rather than relaxing the rule. A boxed dialog is not detected, and
  // that is deliberate: a miss is fail-safe (visible dialog + the new warning),
  // whereas tolerating border rows below the footer would admit a quoted dialog
  // sitting above an empty input box, whose rows are pure border characters.
  // This test exists so the behaviour is a decision on record, not an accident.
  it('fails CLOSED on a boxed rendering (deliberate — see M2)', async () => {
    const boxed = [
      '  ╭────────────────────────────────────────╮',
      '  │ WARNING: Bypass Permissions mode       │',
      '  │ ❯ No, exit                             │',
      '  │   Yes, I accept                        │',
      '  │ Enter to confirm · Esc to cancel       │',
      '  ╰────────────────────────────────────────╯',
      ...Array.from({ length: 44 }, () => ''),
    ];
    const screen = await renderScreen(boxed);
    expect(screen.detectDialog()).toBeNull();
  });
});

describe('decideBypassDialogAction (accepting the bypass dialog across Claude Code versions)', () => {
  const decide = async (rows: string[], keys = 0) => {
    const screen = await renderScreen(dialog(rows));
    // Sanity: every fixture is a screen the detector actually fires on, so the
    // decision is only ever asked about dialogs that reached this code path.
    expect(screen.detectDialog()).toBe('bypass-permissions');
    return decideBypassDialogAction(screen.dialogText(), { keys, misses: 0 });
  };

  /** For screens the detector rejects: assert that, then ask the action layer
   *  directly — it must refuse independently, so the two cannot drift apart. */
  const decideUndetected = async (lines: string[], keys = 0) => {
    const screen = await renderScreen(lines);
    expect(screen.detectDialog()).toBeNull();
    return decideBypassDialogAction(screen.dialogText(), { keys, misses: 0 });
  };


  it('types the digit on the numbered rendering (<= 2.1.247 behavior, unchanged)', async () => {
    // Proven live on 2.1.247: the digit alone selects AND confirms — Claude
    // Code dismissed the dialog and persisted skipDangerousModePermissionPrompt.
    expect(await decide(LEGACY_ROWS)).toEqual({ kind: 'digit', key: '2' });
  });

  it('reads the digit off the accept row instead of hard-coding it', async () => {
    // Same numbered shape with the options ordered the other way. The pre-#431
    // code sent a hard-coded '2', which here means "No, exit" — i.e. it would
    // have killed the session rather than accepted.
    const action = await decide(['  ❯ 1. Yes, I accept', '    2. No, exit']);
    expect(action).toEqual({ kind: 'digit', key: '1' });
  });

  it('does nothing for a multi-digit index — that is not one keystroke', async () => {
    const action = await decide(['  ❯ 10. No, exit', '    11. Yes, I accept']);
    expect(action.kind).toBe('wait');
  });

  it('moves the caret toward the accept row on the un-numbered rendering (>= 2.1.248)', async () => {
    // Proven live on 2.1.251: '2' leaves the caret untouched, Down moves it.
    expect(await decide(CURRENT_ROWS)).toEqual({ kind: 'move', key: BYPASS_KEY_DOWN });
  });

  it('confirms only once the caret is observed on the accept row', async () => {
    expect(await decide(CURRENT_ROWS_AFTER_DOWN)).toEqual({ kind: 'confirm', key: BYPASS_KEY_ENTER });
  });

  it('moves up when the accept row is listed above the caret', async () => {
    const action = await decide(['    Yes, I accept', '  ❯ No, exit']);
    expect(action).toEqual({ kind: 'move', key: BYPASS_KEY_UP });
  });

  it('NEVER confirms while the caret is on "No, exit" (that keystroke exits Claude Code)', async () => {
    for (const rows of [CURRENT_ROWS, ['    Yes, I accept', '  ❯ No, exit']]) {
      const action = await decide(rows);
      expect(action.kind).not.toBe('confirm');
    }
  });

  it('does nothing when no row is highlighted (still rendering / not the live dialog)', async () => {
    const action = await decideUndetected(dialog(['    No, exit', '    Yes, I accept']));
    expect(action.kind).toBe('wait');
  });

  it('does nothing when both rows carry a caret (shape we do not understand)', async () => {
    const action = await decideUndetected(dialog(['  ❯ No, exit', '  ❯ Yes, I accept']));
    expect(action.kind).toBe('wait');
  });

  it('stops sending keys once the budget is spent, rather than guessing Enter', async () => {
    const action = await decide(CURRENT_ROWS, BYPASS_MAX_KEYS);
    expect(action.kind).toBe('wait');
    // One below the cap still moves — the budget bounds key traffic, it does
    // not disable the fix.
    expect(await decide(CURRENT_ROWS, BYPASS_MAX_KEYS - 1)).toEqual({ kind: 'move', key: BYPASS_KEY_DOWN });
  });

  it('keeps retrying for the whole startup window, not a fraction of it', () => {
    // The pre-#431 code retried every DIALOG_ACTION_COOLDOWN_MS until the
    // startup timeout. A ceiling below that many rounds would go silent while
    // the shell is still starting, so a dialog that merely swallowed its first
    // keystrokes would never be retried and would die at the startup timeout
    // into a respawn loop — the very symptom #431 is about.
    //
    // claude-pty-shell.ts self-starts a Driver at import, so the two constants
    // are read back out of its source instead of imported.
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/shell/claude-pty-shell.ts'),
      'utf8',
    );
    const numberOf = (name: string): number => {
      const m = new RegExp(`const ${name} = ([\\d_]+);`).exec(src);
      if (!m) throw new Error(`${name} not found in claude-pty-shell.ts — update this test`);
      return Number(m[1].replace(/_/g, ''));
    };
    const rounds = numberOf('STARTUP_TIMEOUT_MS') / numberOf('DIALOG_ACTION_COOLDOWN_MS');
    expect(rounds).toBeGreaterThan(0);
    expect(BYPASS_MAX_KEYS).toBeGreaterThanOrEqual(rounds);
  });

  it('does not refill the budget on a single missed detection', () => {
    // Detection is structural, so a mid-repaint frame — rows drawn, footer not
    // yet, or the caret momentarily on neither row — reads as absent for one
    // round while the dialog is still up. Refilling there would defeat the
    // ceiling exactly when it is needed.
    const state = { keys: 5, misses: 0 };
    noteDialogAbsent(state);
    expect(state.keys).toBe(5);
  });

  it('refills the budget once the dialog has been gone for several rounds', () => {
    const state = { keys: 5, misses: 0 };
    for (let i = 0; i < BYPASS_RESET_AFTER_MISSES; i++) noteDialogAbsent(state);
    expect(state.keys).toBe(0);
  });

  it('restarts the miss run whenever the dialog is seen again', () => {
    // A flicker (seen, missed, seen, missed, …) must never accumulate its way
    // to a refill while the dialog is still on screen.
    const state = { keys: 5, misses: 0 };
    for (let i = 0; i < 10; i++) {
      noteDialogAbsent(state);
      noteDialogPresent(state);
    }
    expect(state.keys).toBe(5);
  });

  it('matches the option labels literally, so a label edit cannot widen the pattern', () => {
    // rowPattern() interpolates the label into a RegExp built at module load,
    // and the labels are meant to be edited when the TUI changes. Unescaped,
    // '.' would silently become a wildcard...
    expect(rowPattern('a.c').test('  abc')).toBe(false);
    expect(rowPattern('a.c').test('  a.c')).toBe(true);
    // ...and an unbalanced group would throw at import time, taking down every
    // PTY session rather than one dialog.
    expect(() => rowPattern('Yes (really)')).not.toThrow();
    expect(rowPattern('Yes (really)').test('  ❯ Yes (really)')).toBe(true);
  });

  it('bounds the digit path too — an unresponsive numbered dialog is #431 all over again', async () => {
    // Keys sent at a dialog that ignores them are not discarded, they queue and
    // land in the prompt later, so the digit gets the same budget as the arrows.
    expect((await decide(LEGACY_ROWS, BYPASS_MAX_KEYS)).kind).toBe('wait');
    expect(await decide(LEGACY_ROWS, BYPASS_MAX_KEYS - 1)).toEqual({ kind: 'digit', key: '2' });
  });

  it('bounds repeated Enter at a dialog that will not dismiss', async () => {
    expect((await decide(CURRENT_ROWS_AFTER_DOWN, BYPASS_MAX_KEYS)).kind).toBe('wait');
  });

  it('keeps the accept label in sync with the detection marker in screen.ts', async () => {
    // The label is duplicated (this module stays dependency-free), so drift
    // would mean detectDialog() fires on a dialog whose rows we cannot parse.
    expect(TUI_BYPASS_PERMS).toContain(BYPASS_ACCEPT_LABEL);
    // Same for the heading, which isBypassDialogOnScreen() now gates on: if it
    // drifted from screen.ts's marker list the predicate would reject every real
    // dialog, silently restoring the #436 wedge.
    expect(TUI_BYPASS_PERMS).toContain(BYPASS_HEADING);
    expect(await decide([`  ❯ ${BYPASS_DECLINE_LABEL}`, `    ${BYPASS_ACCEPT_LABEL}`])).toEqual({
      kind: 'move',
      key: BYPASS_KEY_DOWN,
    });
  });

  it('ignores prose that merely quotes the labels mid-sentence', async () => {
    const action = await decideUndetected(dialog([
      '  ❯ No, exit',
      '  You will be asked to pick Yes, I accept before the session starts.',
    ]));
    expect(action.kind).toBe('wait');
  });

  it('acts only on what the detector fired for (quoted dialog in scrollback)', async () => {
    // Same rule detectDialog() applies, enforced independently here: a modal
    // with conversation and an idle caret rendered below it is a record of a
    // dialog, not one we can drive — and must not attract a keystroke.
    const screen = await renderScreen([...dialog(CURRENT_ROWS_AFTER_DOWN), ...FILLER(44), '❯ ']);
    expect(screen.detectDialog()).toBeNull();
    expect(decideBypassDialogAction(screen.dialogText(), { keys: 0, misses: 0 }).kind).toBe('wait');
  });
});

describe('ScreenModel readInteractivePrompt (permission-style Yes/No prompt)', () => {
  // Claude Code's tool-permission footer — kept in fixtures to mirror real TUI
  // output, but readInteractivePrompt() no longer requires it (see planning-61:
  // liveness is now proven behaviorally by the probe, not by footer text).
  const PERM_FOOTER = 'Esc to cancel · Tab to amend · ctrl+e to explain';

  it('detects the dangerous-rm circuit-breaker prompt (boxed) and parses Yes/No', async () => {
    const screen = await renderScreen([
      ...FILLER(38),
      '╭──────────────────────────────────────────────────────────────╮',
      '│ Dangerous rm operation on possibly-empty variable path: "$OLD"/*.sql',
      '│',
      '│ Do you want to proceed?',
      '│ ❯ 1. Yes',
      '│   2. No',
      '╰──────────────────────────────────────────────────────────────╯',
      PERM_FOOTER,
    ]);
    const prompt = screen.readInteractivePrompt();
    expect(prompt).not.toBeNull();
    expect(prompt!.isPermission).toBe(true);
    expect(prompt!.options.map((o) => o.label)).toEqual(['Yes', 'No']);
    expect(prompt!.highlighted).toBe(1);
    // Context echoes the guarded command (box borders stripped), not the filler.
    expect(prompt!.context).toContain('Dangerous rm operation');
    expect(prompt!.context).not.toContain('conversation line');
  });

  it('also parses an unboxed prompt (options indented, no box border)', async () => {
    const screen = await renderScreen([
      ...FILLER(42),
      'Do you want to proceed?',
      '  ❯ 1. Yes',
      '    2. No',
      PERM_FOOTER,
    ]);
    const prompt = screen.readInteractivePrompt();
    expect(prompt).not.toBeNull();
    expect(prompt!.options.map((o) => o.label)).toEqual(['Yes', 'No']);
  });

  it('detects the prompt even with no footer line at all (no longer footer-gated)', async () => {
    // The old detector required a permission-specific footer token before
    // trusting the screen; the new reader doesn't need it because liveness
    // was already proven behaviorally before this is ever called.
    const screen = await renderScreen([
      ...FILLER(44),
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No',
    ]);
    const prompt = screen.readInteractivePrompt();
    expect(prompt).not.toBeNull();
    expect(prompt!.options.map((o) => o.label)).toEqual(['Yes', 'No']);
  });

  it('ignores the prompt when it sits in upper scrollback (quoted prose)', async () => {
    // An agent explaining the wedge, or re-injected history: the question +
    // footer tokens are near the top, above the bottom region → no false bridge.
    const screen = await renderScreen([
      'Assistant: it showed "Do you want to proceed?" 1. Yes 2. No (Tab to amend)',
      ...FILLER(44),
      '❯ ',
    ]);
    expect(screen.readInteractivePrompt()).toBeNull();
  });

  it('requires a ❯ selection caret — a numbered list in prose never trips it', async () => {
    // Conversational text that happens to pair the question with a numbered
    // list. With no live select caret on an option row it is still not a
    // real prompt → no bridge.
    const screen = await renderScreen([
      ...FILLER(40),
      'Do you want to proceed? Here is the plan I would run:',
      '1. Back up the directory first',
      '2. Then remove the old files',
      PERM_FOOTER,
    ]);
    expect(screen.readInteractivePrompt()).toBeNull();
  });

  it('a markdown blockquote "> 1." beside the question is not a caret either', async () => {
    const screen = await renderScreen([
      ...FILLER(40),
      'Do you want to proceed? The choices were quoted as:',
      '> 1. Yes',
      '> 2. No',
      PERM_FOOTER,
    ]);
    expect(screen.readInteractivePrompt()).toBeNull();
  });

  it('binds context to the question NEAREST the options when an earlier one is quoted', async () => {
    // A line higher in the bottom region quotes the question; the live boxed prompt
    // sits below it. Using the LAST occurrence keeps the context anchored to the
    // real dialog box (the guarded command), not emptied by the quote above.
    const screen = await renderScreen([
      ...FILLER(36),
      'Note: earlier I asked "Do you want to proceed?" before — here is the real one:',
      '╭──────────────────────────────────────────────────────────────╮',
      '│ Dangerous rm operation on possibly-empty variable path: "$OLD"/*.sql',
      '│ Do you want to proceed?',
      '│ ❯ 1. Yes',
      '│   2. No',
      '╰──────────────────────────────────────────────────────────────╯',
      PERM_FOOTER,
    ]);
    const prompt = screen.readInteractivePrompt();
    expect(prompt).not.toBeNull();
    expect(prompt!.options.map((o) => o.label)).toEqual(['Yes', 'No']);
    expect(prompt!.context).toContain('Dangerous rm operation');
    expect(prompt!.context).not.toContain('conversation line');
    expect(prompt!.context).not.toContain('earlier I asked');
  });
});

describe('formatPermissionPrompt', () => {
  it('leads with a warning, echoes context, and numbers the options', () => {
    const text = formatPermissionPrompt(
      'Dangerous rm operation on possibly-empty variable path: "$OLD"/*.sql',
      [{ index: 1, label: 'Yes' }, { index: 2, label: 'No' }],
    );
    expect(text.toLowerCase()).toContain('permission');
    expect(text).toContain('Dangerous rm operation');
    expect(text).toContain('1. Yes');
    expect(text).toContain('2. No');
    expect(text.toLowerCase()).toContain('reply with the number');
  });

  it('omits the context block when there is none (no stray blank lines)', () => {
    const text = formatPermissionPrompt('', [{ index: 1, label: 'Yes' }, { index: 2, label: 'No' }]);
    expect(text).toContain('1. Yes');
    expect(text).not.toContain('\n\n\n');
  });
});

describe('menu-probe decideProbeAttempt (behavioral probe round budget)', () => {
  // Mirrors decideMenuCancel's test style: pure per-round bookkeeping, kept
  // free of node-pty/screen imports so it's cheap to test in isolation.
  const T0 = 100_000;
  const baseState = (): ProbeState => ({ lastAttemptAt: T0, rounds: 1 });

  it('sends a new round once the cooldown has elapsed', () => {
    const action = decideProbeAttempt(baseState(), { now: T0 + PROBE_RETRY_COOLDOWN_MS });
    expect(action).toBe('send');
  });

  it('waits while still within the cooldown window since the last attempt', () => {
    const action = decideProbeAttempt(baseState(), { now: T0 + PROBE_RETRY_COOLDOWN_MS - 1 });
    expect(action).toBe('wait');
  });

  it('sends the very first round immediately (lastAttemptAt=0 is far in the past)', () => {
    const action = decideProbeAttempt({ lastAttemptAt: 0, rounds: 0 }, { now: T0 });
    expect(action).toBe('send');
  });

  it('gives up once PROBE_MAX_ROUNDS have been spent, regardless of cooldown', () => {
    const action = decideProbeAttempt(
      { lastAttemptAt: T0, rounds: PROBE_MAX_ROUNDS },
      { now: T0 + PROBE_RETRY_COOLDOWN_MS + 10_000 },
    );
    expect(action).toBe('give-up');
  });

  it('give-up takes priority over cooldown (both conditions true)', () => {
    const action = decideProbeAttempt(
      { lastAttemptAt: T0, rounds: PROBE_MAX_ROUNDS },
      { now: T0 }, // also within cooldown
    );
    expect(action).toBe('give-up');
  });
});

describe('menu-probe confirmProbeReaction (highlight-move confirmation)', () => {
  // The plan's point-2 "before/after comparison of the highlighted row"
  // (post-review hardening F1): a probe keystroke only counts as a menu
  // reaction when the SAME-shaped prompt parses in both snapshots and the
  // ❯-highlighted index moved. A raw screen-text diff bridged fabricated
  // menus when Up-recall changed the screen around static menu-shaped text.
  const readout = (highlighted: number, count = 3) => ({
    options: Array.from({ length: count }, (_, i) => ({ index: i + 1, label: `opt ${i + 1}` })),
    highlighted,
  });

  it('confirms when the highlight moved (Down: 1→2, and the Up fallback: 3→2)', () => {
    expect(confirmProbeReaction(readout(1), readout(2))).toBe(true);
    expect(confirmProbeReaction(readout(3), readout(2))).toBe(true);
  });

  it('rejects when the highlight did not move — static menu-shaped text cannot react', () => {
    expect(confirmProbeReaction(readout(1), readout(1))).toBe(false);
  });

  it('rejects when either snapshot has no parseable prompt', () => {
    expect(confirmProbeReaction(null, readout(2))).toBe(false);
    expect(confirmProbeReaction(readout(1), null)).toBe(false);
    expect(confirmProbeReaction(null, null)).toBe(false);
  });

  it('rejects when the option count changed (different prompt, not a reaction)', () => {
    expect(confirmProbeReaction(readout(1, 3), readout(2, 4))).toBe(false);
  });
});

describe('isSyntheticRequestTooLarge (authoritative 413 detection)', () => {
  const overlayText = 'Request too large (max 32MB). Double press esc to go back and try with a smaller file.';

  it('detects the genuine error: <synthetic> model + overlay text', () => {
    expect(isSyntheticRequestTooLarge({
      role: 'assistant',
      model: '<synthetic>',
      content: [{ type: 'text', text: overlayText }],
    })).toBe(true);
  });

  it('ignores a real assistant reply that quotes the error verbatim (real model id)', () => {
    // The "เนี่ย นายก็เป็น" case: an agent explaining this very bug in a live reply.
    // Real model id ≠ <synthetic>, so it is never treated as a genuine error.
    expect(isSyntheticRequestTooLarge({
      role: 'assistant',
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text: `อย่างที่เห็น TUI เด้ง "${overlayText}"` }],
    })).toBe(false);
  });

  it('ignores a synthetic record without the overlay text (other API error)', () => {
    expect(isSyntheticRequestTooLarge({
      role: 'assistant',
      model: '<synthetic>',
      content: [{ type: 'text', text: 'API Error: 500 internal error' }],
    })).toBe(false);
  });

  it('ignores a record with no model field', () => {
    expect(isSyntheticRequestTooLarge({
      role: 'assistant',
      content: [{ type: 'text', text: overlayText }],
    })).toBe(false);
  });

  it('tolerates content blocks without text (e.g. tool_use)', () => {
    expect(isSyntheticRequestTooLarge({
      role: 'assistant',
      model: '<synthetic>',
      content: [{ type: 'tool_use', id: 'x' }, { type: 'text', text: overlayText }],
    })).toBe(true);
  });
});

describe('shouldAdoptOrphanWake (autonomous-wake turn adoption)', () => {
  // Models Bug 3: a background Task's completion notification re-invokes
  // Claude with no user message → assistant records stream in with no
  // ActiveTurn → tick() skips result forwarding and menu bridging, so a plan
  // approval / AskUserQuestion the wake ends on blocks the session silently.
  const baseObs = (over: Partial<OrphanWakeObs> = {}): OrphanWakeObs => ({
    hasTurn: false,
    exiting: false,
    interrupting: false,
    menuCancelActive: false,
    pendingMenu: false,
    screenBusy: true,
    screenHasPrompt: false,
    ...over,
  });

  it('adopts the wake when there is no turn and the screen is busy', () => {
    expect(shouldAdoptOrphanWake(baseObs())).toBe(true);
  });

  it('adopts the wake when not busy yet but the idle prompt is gone (turn just starting)', () => {
    expect(shouldAdoptOrphanWake(baseObs({ screenBusy: false, screenHasPrompt: false }))).toBe(true);
  });

  it('does NOT adopt a straggler record flushed after finishTurn (idle prompt on screen)', () => {
    // The safety gate: idle prompt back on screen means the turn already
    // ended — fabricating a turn here would re-forward stale text.
    expect(shouldAdoptOrphanWake(baseObs({ screenBusy: false, screenHasPrompt: true }))).toBe(false);
  });

  it('does NOT adopt when a turn already exists (normal flow)', () => {
    expect(shouldAdoptOrphanWake(baseObs({ hasTurn: true }))).toBe(false);
  });

  it('does NOT adopt while exiting, interrupting, menu-cancelling, or a menu is pending', () => {
    expect(shouldAdoptOrphanWake(baseObs({ exiting: true }))).toBe(false);
    expect(shouldAdoptOrphanWake(baseObs({ interrupting: true }))).toBe(false);
    expect(shouldAdoptOrphanWake(baseObs({ menuCancelActive: true }))).toBe(false);
    expect(shouldAdoptOrphanWake(baseObs({ pendingMenu: true }))).toBe(false);
  });
});

describe('pty-shell menu-cancel settle decision', () => {
  // Models the bug: user types a free-text question while a bridged menu is up.
  // The wrapper ESCs the menu, then must wait for the TUI to return to an idle
  // prompt before submitting — submitting into Claude's cancellation redraw is
  // what caused the 30-min watchdog hang.
  const T0 = 100_000;
  const baseState = (): MenuCancelState => ({ since: T0, lastEscAt: T0, escs: 1 });

  it('waits while the TUI is still busy reacting to the ESC cancel', () => {
    const action = decideMenuCancel(baseState(), {
      now: T0 + 1000,            // past MIN_WAIT
      menuVisible: false,        // menu dismissed
      hasPrompt: false,          // but no idle prompt yet
      isBusy: true,              // Claude is processing the cancellation
      quietMs: 50,
    });
    expect(action).toBe('wait');
  });

  it('waits until the minimum delay after ESC has elapsed', () => {
    const action = decideMenuCancel(baseState(), {
      now: T0 + 300,             // < MIN_WAIT (800ms)
      menuVisible: false,
      hasPrompt: true,
      isBusy: false,
      quietMs: 1000,
    });
    expect(action).toBe('wait');
  });

  it('waits until the screen has been quiet long enough', () => {
    const action = decideMenuCancel(baseState(), {
      now: T0 + 1000,
      menuVisible: false,
      hasPrompt: true,
      isBusy: false,
      quietMs: 100,              // < SETTLE_QUIET (600ms)
    });
    expect(action).toBe('wait');
  });

  it('submits once the menu is gone and the prompt is idle and quiet', () => {
    const action = decideMenuCancel(baseState(), {
      now: T0 + 1200,
      menuVisible: false,
      hasPrompt: true,
      isBusy: false,
      quietMs: 700,
    });
    expect(action).toBe('submit');
  });

  it('re-sends ESC when the menu lingers (ESC swallowed) within the retry cap', () => {
    const action = decideMenuCancel(
      { since: T0, lastEscAt: T0, escs: 1 },
      {
        now: T0 + 2000,          // > ESC_RETRY (1500ms) since last ESC
        menuVisible: true,       // menu still on screen
        hasPrompt: false,
        isBusy: false,
        quietMs: 800,
      },
    );
    expect(action).toBe('resend-esc');
  });

  it('stops re-sending ESC after the cap and just waits', () => {
    const action = decideMenuCancel(
      { since: T0, lastEscAt: T0, escs: 3 },   // at MAX_ESC
      {
        now: T0 + 5000,
        menuVisible: true,
        hasPrompt: false,
        isBusy: false,
        quietMs: 800,
      },
    );
    expect(action).toBe('wait');
  });

  it('force-submits after the hard timeout so the session never hangs', () => {
    const action = decideMenuCancel(baseState(), {
      now: T0 + 16_000,          // > TIMEOUT (15s)
      menuVisible: true,         // even if the menu is somehow still up
      hasPrompt: false,
      isBusy: true,
      quietMs: 0,
    });
    expect(action).toBe('submit');
  });
});

describe('pty-shell /stop interrupt settle decision', () => {
  // Models the /stop bug: user issues /stop (SIGINT → ESC interrupts the turn),
  // then sends another message. The interrupted turn writes no turn_duration, so
  // the wrapper must end it once the TUI returns to an idle prompt before draining
  // the queued message — otherwise it hangs behind a dead turn until the watchdog.
  // The interrupt path reuses decideMenuCancel with menuVisible ALWAYS false, so it
  // must never return 'resend-esc' (an ESC then would cancel something unrelated).
  const T0 = 200_000;
  const armed = (): MenuCancelState => ({ since: T0, lastEscAt: T0, escs: 1 });

  it('waits while the TUI is still busy reacting to the ESC interrupt', () => {
    const action = decideMenuCancel(armed(), {
      now: T0 + 1000,            // past MIN_WAIT
      menuVisible: false,        // no menu is involved in /stop
      hasPrompt: false,          // not back to an idle prompt yet
      isBusy: true,              // Claude is still cancelling the turn
      quietMs: 50,
    });
    expect(action).toBe('wait');
  });

  it('ends the interrupted turn once the prompt is idle and quiet', () => {
    const action = decideMenuCancel(armed(), {
      now: T0 + 1200,
      menuVisible: false,
      hasPrompt: true,
      isBusy: false,
      quietMs: 700,
    });
    expect(action).toBe('submit');
  });

  it('never re-sends ESC during a /stop interrupt (no menu on screen)', () => {
    // Even long after the ESC with the screen quiet but no prompt yet, a /stop
    // settle must not emit ESC — menuVisible is false so resend-esc is impossible.
    const action = decideMenuCancel(armed(), {
      now: T0 + 5000,            // well past ESC_RETRY
      menuVisible: false,
      hasPrompt: false,
      isBusy: false,
      quietMs: 2000,
    });
    expect(action).toBe('wait');
  });

  it('force-ends after the hard timeout so /stop never wedges the queue', () => {
    const action = decideMenuCancel(armed(), {
      now: T0 + 16_000,          // > TIMEOUT (15s)
      menuVisible: false,
      hasPrompt: false,          // TUI never settled
      isBusy: true,
      quietMs: 0,
    });
    expect(action).toBe('submit');
  });
});

describe('ProtocolEmitter signals', () => {
  const SID = '11111111-2222-3333-4444-555555555555';

  // Collect each newline-delimited JSON line the emitter writes.
  function captureEmitter(): { emitter: ProtocolEmitter; lines: () => Record<string, unknown>[] } {
    const out: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) { out.push(chunk.toString()); cb(); },
    });
    return {
      emitter: new ProtocolEmitter(sink),
      lines: () => out.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    };
  }

  it('emitRequestTooLarge emits a request_too_large system event', () => {
    const { emitter, lines } = captureEmitter();
    emitter.emitRequestTooLarge(SID);
    expect(lines()).toEqual([
      { type: 'system', subtype: 'request_too_large', session_id: SID },
    ]);
  });

  it('emitSessionIdle emits a session_idle event runner uses to stop typing', () => {
    const { emitter, lines } = captureEmitter();
    emitter.emitSessionIdle(SID);
    expect(lines()).toEqual([{ type: 'session_idle', session_id: SID }]);
  });
});
