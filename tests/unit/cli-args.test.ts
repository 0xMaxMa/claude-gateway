import { parseCliArgs } from '../../src/cli/args';
import { classifyInvocation, isCliCommand, isGatewayStartInvocation, CORE_COMMANDS } from '../../src/cli/command-names';
import { GENERATED_NOUNS } from '../../src/cli/commands.generated';

describe('cli args parseCliArgs', () => {
  it('separates positionals from flags', () => {
    expect(parseCliArgs(['restart', 'agent-1', 'sid-9', '--json'])).toEqual({
      positionals: ['restart', 'agent-1', 'sid-9'],
      flags: { json: true },
    });
  });

  it('supports --flag value and --flag=value', () => {
    expect(parseCliArgs(['--url', 'http://x:1', '--key=abc', '--limit', '5'])).toEqual({
      positionals: [],
      flags: { url: 'http://x:1', key: 'abc', limit: '5' },
    });
  });

  it('treats a flag followed by another flag as boolean', () => {
    expect(parseCliArgs(['--force', '--json'])).toEqual({ positionals: [], flags: { force: true, json: true } });
  });

  it('without a declared boolean set, a flag before a positional swallows it as its value (documents the trap)', () => {
    expect(parseCliArgs(['--force', 'sid-9'])).toEqual({ positionals: [], flags: { force: 'sid-9' } });
  });

  it('a declared boolean flag never consumes the next token, even when it looks like a positional', () => {
    expect(parseCliArgs(['--force', 'sid-9', 'extra'], new Set(['force']))).toEqual({
      positionals: ['sid-9', 'extra'],
      flags: { force: true },
    });
  });

  it('--flag=value form still wins over a declared boolean set', () => {
    expect(parseCliArgs(['--force=true'], new Set(['force']))).toEqual({ positionals: [], flags: { force: 'true' } });
  });
});

describe('cli command-names isCliCommand', () => {
  it('is true for every core command', () => {
    for (const c of CORE_COMMANDS) expect(isCliCommand(c)).toBe(true);
  });

  it('is true for generated resource nouns (e.g. crons)', () => {
    expect(GENERATED_NOUNS).toContain('crons');
    expect(isCliCommand('crons')).toBe(true);
  });

  it('is false for undefined (no command name to classify)', () => {
    expect(isCliCommand(undefined)).toBe(false);
  });

  it('is false for a flag-first invocation', () => {
    expect(isCliCommand('--config')).toBe(false);
    expect(isCliCommand('--help')).toBe(false);
  });

  it('is false for an unknown token', () => {
    expect(isCliCommand('definitely-not-a-command')).toBe(false);
  });
});

/**
 * The boot decision. Discovery must never leave a server listening: only an
 * explicit `gateway start` boots, with one narrow exception for pre-1.8 unit
 * files that call the binary with no command at all (those would otherwise
 * restart-loop on an instant exit-0 help screen).
 */
describe('cli command-names classifyInvocation', () => {
  const bare = {};
  const systemd = { INVOCATION_ID: 'abc123' };
  const pm2 = { pm_id: '0' };

  it('boots only on an explicit `gateway start`', () => {
    expect(isGatewayStartInvocation(['gateway', 'start'])).toBe(true);
    expect(classifyInvocation(['gateway', 'start'], bare)).toBe('boot');
    expect(classifyInvocation(['gateway', 'start', '--config', '/tmp/c.json'], bare)).toBe('boot');
    expect(classifyInvocation(['gateway', 'start'], systemd)).toBe('boot');
  });

  it('routes a bare invocation from a terminal to the CLI (help), never the server', () => {
    expect(classifyInvocation([], bare)).toBe('cli');
    expect(classifyInvocation(['--help'], bare)).toBe('cli');
    expect(classifyInvocation(['--version'], bare)).toBe('cli');
    expect(classifyInvocation(['--config', '/tmp/c.json'], bare)).toBe('cli');
  });

  it('routes typos and other lifecycle verbs to the CLI so they cannot start a server', () => {
    expect(classifyInvocation(['start'], bare)).toBe('cli');
    expect(classifyInvocation(['update'], bare)).toBe('cli');
    expect(classifyInvocation(['gateway'], bare)).toBe('cli');
    expect(classifyInvocation(['gateway', 'status'], bare)).toBe('cli');
    expect(classifyInvocation(['definitely-not-a-command'], bare)).toBe('cli');
    expect(classifyInvocation(['start'], systemd)).toBe('cli');
  });

  it('keeps pre-1.8 supervised units booting when they pass no command', () => {
    expect(classifyInvocation([], systemd)).toBe('legacy-boot');
    expect(classifyInvocation([], pm2)).toBe('legacy-boot');
    expect(classifyInvocation(['--config', '/etc/cg.json'], systemd)).toBe('legacy-boot');
  });

  it('does not treat a supervised --help/--version as a boot request', () => {
    expect(classifyInvocation(['--help'], systemd)).toBe('cli');
    expect(classifyInvocation(['--version'], systemd)).toBe('cli');
  });
});
