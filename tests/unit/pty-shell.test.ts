import { translateArgs, sanitizeUserText } from '../../src/shell/args';
import { projectSlug, transcriptPath } from '../../src/shell/tailer';
import {
  ScreenModel,
  TUI_BUSY_MARKER,
  TUI_BYPASS_PERMS,
  TUI_REQUEST_TOO_LARGE,
  TUI_REQUEST_TOO_LARGE_DISMISS,
  parseMenuChoice,
  formatMenuPrompt,
  extractChannelContent,
  isPtyActivelyWorking,
} from '../../src/shell/screen';
import { ProtocolEmitter } from '../../src/shell/emitter';
import { Writable } from 'stream';
import { preTrustWorkspace, checkAuthStatus } from '../../src/shell/trust';
import { decideMenuCancel, MenuCancelState } from '../../src/shell/menu-cancel';
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
  it('BUSY_MARKER matches expected status bar text', () => {
    expect(TUI_BUSY_MARKER).toBe('esc to interrupt');
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

describe('ScreenModel detectRequestTooLarge', () => {
  it('detects the recoverable 32MB error overlay', async () => {
    const screen = await renderScreen([
      '  Read 1 file',
      '',
      '  Request too large (max 32MB). Double press esc to go back',
      '',
    ]);
    expect(screen.detectRequestTooLarge()).toBe(true);
  });

  it('is false on a normal idle screen', async () => {
    const screen = await renderScreen([
      '❯ ',
      'ready for input',
    ]);
    expect(screen.detectRequestTooLarge()).toBe(false);
  });

  it('does not false-positive on prose merely discussing the error', async () => {
    // The matcher keys on the exact "(max" suffix the TUI renders, so an agent
    // explaining the concept ("a request that is too large") never trips it.
    const screen = await renderScreen([
      'If a request is too large the API rejects it.',
    ]);
    expect(screen.detectRequestTooLarge()).toBe(false);
  });

  it('does not trip when the agent quotes the exact error text without the dismiss footer', async () => {
    // Self-trigger guard: the agent's own reply may contain the verbatim error
    // string (e.g. explaining this very bug). Detection requires the dismiss
    // footer too, which only the real overlay renders — so quoted prose is inert.
    const screen = await renderScreen([
      'When the TUI shows "Request too large (max 32MB)" the session must restart.',
      '❯ ',
    ]);
    expect(screen.detectRequestTooLarge()).toBe(false);
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
    // Busy marker present → alive regardless of quietMs / prompt state.
    expect(isPtyActivelyWorking({ isBusy: true, hasPrompt: false, quietMs: 999_999 }, LIVENESS)).toBe(true);
  });

  it('alive when PTY emitted output recently while not at an idle prompt', () => {
    // The core fix: compaction / large-request assembly / sub-agent runs drop the
    // "esc to interrupt" marker (isBusy=false) but keep animating → quietMs stays low.
    expect(isPtyActivelyWorking({ isBusy: false, hasPrompt: false, quietMs: 1_000 }, LIVENESS)).toBe(true);
  });

  it('NOT alive when genuinely quiet for longer than the liveness window (hung)', () => {
    // No spinner, no recent output → let the receiver's stalled detector fire.
    expect(isPtyActivelyWorking({ isBusy: false, hasPrompt: false, quietMs: 60_000 }, LIVENESS)).toBe(false);
  });

  it('NOT alive when parked at an idle prompt even with recent output', () => {
    // Settling to the idle prompt after a turn must not keep the heartbeat beating.
    expect(isPtyActivelyWorking({ isBusy: false, hasPrompt: true, quietMs: 100 }, LIVENESS)).toBe(false);
  });

  it('liveness window is a strict bound (quietMs === window is NOT alive)', () => {
    expect(isPtyActivelyWorking({ isBusy: false, hasPrompt: false, quietMs: LIVENESS }, LIVENESS)).toBe(false);
    expect(isPtyActivelyWorking({ isBusy: false, hasPrompt: false, quietMs: LIVENESS - 1 }, LIVENESS)).toBe(true);
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

describe('ScreenModel detectMenu', () => {
  it('parses numbered options (with ❯ highlight + a divider) when the footer is present', async () => {
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
    const menu = screen.detectMenu();
    expect(menu).not.toBeNull();
    expect(menu!.map((o) => o.index)).toEqual([1, 2, 3, 4]);
    expect(menu![0].label).toBe('First choice');
    expect(menu![3].label).toBe('Chat about this');
  });

  it('ignores stale numbered scrollback above the live menu', async () => {
    // Reproduces the live bug: a prior chat message rendered as "1. … 2. …"
    // sat in scrollback above an AskUserQuestion menu, so detectMenu swept the
    // phantom rows in — inflating the option list and shifting every index.
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
    const menu = screen.detectMenu();
    expect(menu).not.toBeNull();
    // Only the real 1..3 run nearest the footer — phantom rows excluded.
    expect(menu!.map((o) => o.index)).toEqual([1, 2, 3]);
    expect(menu![0].label).toBe('See the buttons');
    expect(menu!.map((o) => o.label)).not.toContain('restart gateway now');
  });

  it('returns null without the menu footer', async () => {
    const screen = await renderScreen([
      'Here is a numbered list in normal output:',
      '1. not a menu',
      '2. still not a menu',
    ]);
    expect(screen.detectMenu()).toBeNull();
  });

  it('returns null with the footer but fewer than two options', async () => {
    const screen = await renderScreen([
      'Confirm?',
      '  1. Only choice',
      MENU_FOOTER,
    ]);
    expect(screen.detectMenu()).toBeNull();
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
