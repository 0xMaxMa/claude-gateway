import { parseCliArgs } from '../../src/cli/args';
import {
  CHILD_MARKER,
  claimSupervisorEnv,
  classifyInvocation,
  isGatewayStartInvocation,
  isSupervised,
} from '../../src/cli/command-names';

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

  // `-h` used to fall through to positionals, so `crons -h` reported
  // "Unknown command: crons -h" even though `-h` is a documented alias.
  it('expands single-dash aliases to their long names', () => {
    expect(parseCliArgs(['crons', '-h'])).toEqual({ positionals: ['crons'], flags: { help: true } });
    expect(parseCliArgs(['-V'])).toEqual({ positionals: [], flags: { version: true } });
  });

  it('does not let a short flag be swallowed as another flag\'s value', () => {
    expect(parseCliArgs(['--url', '-h'])).toEqual({ positionals: [], flags: { url: true, help: true } });
  });

  it('still treats a dash-prefixed non-letter as a value, not a flag', () => {
    expect(parseCliArgs(['--offset', '-5'])).toEqual({ positionals: [], flags: { offset: '-5' } });
  });
});

/**
 * The supervisor markers systemd and PM2 set are inherited by every descendant,
 * and the gateway spawns agents that have shell access. Without a way to tell
 * the service main process from its own great-grandchildren, a bare
 * `claude-gateway` typed in an agent's shell booted a second server on the
 * gateway's port.
 */
describe('cli command-names isSupervised', () => {
  it('accepts a service main process: markers, no child stamp, no terminal', () => {
    expect(isSupervised({ INVOCATION_ID: 'abc' })).toBe(true);
    expect(isSupervised({ pm_id: '0' })).toBe(true);
    expect(isSupervised({ PM2_HOME: '/home/u/.pm2' })).toBe(true);
  });

  it('rejects a descendant of a running gateway', () => {
    expect(isSupervised({ INVOCATION_ID: 'abc', [CHILD_MARKER]: '1' })).toBe(false);
    expect(isSupervised({ pm_id: '0', [CHILD_MARKER]: '1' })).toBe(false);
  });

  it('rejects an invocation with a terminal attached — no supervisor gives a service one', () => {
    expect(isSupervised({ PM2_HOME: '/home/u/.pm2' }, { hasTty: true })).toBe(false);
  });

  it('is false without any marker', () => {
    expect(isSupervised({})).toBe(false);
  });
});

describe('cli command-names claimSupervisorEnv', () => {
  it('removes the inherited markers and records the supervisor', () => {
    const env: NodeJS.ProcessEnv = { INVOCATION_ID: 'abc', PATH: '/usr/bin' };
    claimSupervisorEnv(env);
    expect(env.INVOCATION_ID).toBeUndefined();
    expect(env.CLAUDE_GATEWAY_SUPERVISOR).toBe('systemd');
    expect(env[CHILD_MARKER]).toBe('1');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('classifies pm2 from either of its markers', () => {
    const byHome: NodeJS.ProcessEnv = { PM2_HOME: '/home/u/.pm2' };
    claimSupervisorEnv(byHome);
    expect(byHome.CLAUDE_GATEWAY_SUPERVISOR).toBe('pm2');
    expect(byHome.PM2_HOME).toBeUndefined();

    const byId: NodeJS.ProcessEnv = { pm_id: '0' };
    claimSupervisorEnv(byId);
    expect(byId.CLAUDE_GATEWAY_SUPERVISOR).toBe('pm2');
  });

  // The end-to-end property: a child of a booted gateway never legacy-boots,
  // whatever it inherited.
  it('leaves an environment in which a bare invocation goes to the CLI', () => {
    const env: NodeJS.ProcessEnv = { INVOCATION_ID: 'abc' };
    expect(classifyInvocation([], env)).toBe('legacy-boot');
    claimSupervisorEnv(env);
    expect(classifyInvocation([], env)).toBe('cli');
  });

  it('records nothing when no supervisor started us', () => {
    const env: NodeJS.ProcessEnv = {};
    claimSupervisorEnv(env);
    expect(env.CLAUDE_GATEWAY_SUPERVISOR).toBeUndefined();
    expect(env[CHILD_MARKER]).toBe('1');
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
