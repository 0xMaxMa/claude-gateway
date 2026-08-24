import { parseCliArgs } from '../../src/cli/args';
import { isCliCommand, CORE_COMMANDS } from '../../src/cli/command-names';
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
});

describe('cli command-names isCliCommand', () => {
  it('is true for every core command', () => {
    for (const c of CORE_COMMANDS) expect(isCliCommand(c)).toBe(true);
  });

  it('is true for generated resource nouns (e.g. crons)', () => {
    expect(GENERATED_NOUNS).toContain('crons');
    expect(isCliCommand('crons')).toBe(true);
  });

  it('is false for undefined (bare invocation → boots the server)', () => {
    expect(isCliCommand(undefined)).toBe(false);
  });

  it('is false for a flag-first invocation (--config ... → boots the server)', () => {
    expect(isCliCommand('--config')).toBe(false);
    expect(isCliCommand('--help')).toBe(false);
  });

  it('is false for an unknown token (unrecognized → boots the server, preserving compat)', () => {
    expect(isCliCommand('definitely-not-a-command')).toBe(false);
  });
});
