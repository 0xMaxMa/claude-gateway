import { translateArgs, sanitizeUserText } from '../../src/shell/args';
import { projectSlug, transcriptPath } from '../../src/shell/tailer';
import {
  ScreenModel,
  TUI_BUSY_MARKER,
  TUI_BYPASS_PERMS,
} from '../../src/shell/screen';
import { preTrustWorkspace, checkAuthStatus } from '../../src/shell/trust';
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
