import { translateArgs, sanitizeUserText } from '../../src/shell/args';
import { projectSlug, transcriptPath } from '../../src/shell/tailer';
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
    const { claudeArgs, model, skipPermissions } = translateArgs(GATEWAY_ARGS);
    expect(claudeArgs).not.toContain('--print');
    expect(claudeArgs).not.toContain('--verbose');
    expect(claudeArgs).not.toContain('--include-partial-messages');
    expect(claudeArgs).not.toContain('--input-format');
    expect(claudeArgs).not.toContain('--output-format');
    expect(claudeArgs).not.toContain('stream-json');
    expect(claudeArgs).toContain('--mcp-config');
    expect(claudeArgs).toContain('/tmp/mcp.json');
    expect(claudeArgs).toContain('--dangerously-skip-permissions');
    expect(model).toBe('claude-sonnet-4-6');
    expect(skipPermissions).toBe(true);
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
