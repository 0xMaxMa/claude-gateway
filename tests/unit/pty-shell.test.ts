import { translateArgs, sanitizeUserText } from '../../src/shell/args';
import { projectSlug, transcriptPath } from '../../src/shell/tailer';
import {
  ScreenModel,
  TUI_BUSY_MARKER,
  TUI_BYPASS_PERMS,
  TUI_TRUST_FOLDER_PATTERNS,
  TUI_CONFIRM_MARKER,
} from '../../src/shell/screen';
import * as os from 'os';

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

  it('TRUST_FOLDER_PATTERNS includes both old and new dialog text', () => {
    expect(TUI_TRUST_FOLDER_PATTERNS).toContain('Do you trust the files in this folder');
    expect(TUI_TRUST_FOLDER_PATTERNS).toContain('Yes, I trust this folder');
    expect(TUI_TRUST_FOLDER_PATTERNS).toContain('Is this a project you created or one you trust');
  });

  it('CONFIRM_MARKER matches expected dialog text', () => {
    expect(TUI_CONFIRM_MARKER).toBe('Enter to confirm');
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
