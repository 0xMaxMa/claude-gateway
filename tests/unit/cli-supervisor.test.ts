import {
  isSupervised,
  claimSupervisorEnv,
  classifyInvocation,
  isDirectSystemdChild,
  resolveInvocationSignals,
  CHILD_MARKER,
  SUPERVISOR_MARKER,
} from '../../src/cli/command-names';

/**
 * The supervisor markers are inherited by every descendant, and the gateway
 * spawns agents that have shells. These specs pin the two things that keeps
 * straight: a descendant can never be mistaken for a service main process, and
 * a real service main process is still recognised as one.
 */
describe('supervisor detection', () => {
  it('treats a child of the gateway as a CLI invocation, whatever else it inherited', () => {
    expect(isSupervised({ INVOCATION_ID: 'abc', [CHILD_MARKER]: '1' }, { parentIsSystemd: true })).toBe(false);
    expect(isSupervised({ PM2_HOME: '/pm2', [CHILD_MARKER]: '1' })).toBe(false);
    expect(isSupervised({ pm_id: '0', [CHILD_MARKER]: '1' })).toBe(false);
  });

  it('recognises a service main process', () => {
    expect(isSupervised({ INVOCATION_ID: 'abc' }, { parentIsSystemd: true })).toBe(true);
    expect(isSupervised({ pm_id: '0' })).toBe(true);
    expect(isSupervised({ PM2_HOME: '/pm2' })).toBe(true);
  });

  /**
   * `INVOCATION_ID` is minted per invocation by systemd and cannot come from a
   * shell profile, so once `parentIsSystemd` proves it belongs to *this*
   * process, a terminal does not overrule it — a legacy unit with
   * `StandardInput=tty` must still boot rather than printing help at its
   * service manager.
   */
  it('still boots a supervised launch that happens to have a terminal', () => {
    expect(isSupervised({ INVOCATION_ID: 'abc' }, { hasTty: true, parentIsSystemd: true })).toBe(true);
    expect(isSupervised({ pm_id: '0' }, { hasTty: true })).toBe(true);
    expect(classifyInvocation([], { INVOCATION_ID: 'abc' }, { hasTty: true, parentIsSystemd: true })).toBe(
      'legacy-boot',
    );
  });

  /**
   * `INVOCATION_ID` is inherited by every descendant of a systemd unit's main
   * process — not just the one systemd forked. A shell reached through an
   * unrelated systemd-managed process (a web-terminal service, say) carries
   * the same env var, but this process's immediate parent is that shell, not
   * systemd. Regression for the false-positive this let through before
   * `parentIsSystemd` existed: bare `claude-gateway`, typed by a human in such
   * a shell, tried to boot a second gateway on top of the one already running.
   */
  it('does not trust an inherited INVOCATION_ID whose parent is not systemd', () => {
    expect(isSupervised({ INVOCATION_ID: 'abc' })).toBe(false);
    expect(isSupervised({ INVOCATION_ID: 'abc' }, { parentIsSystemd: false })).toBe(false);
    expect(isSupervised({ INVOCATION_ID: 'abc' }, { hasTty: true, parentIsSystemd: false })).toBe(false);
    expect(classifyInvocation([], { INVOCATION_ID: 'abc' }, { parentIsSystemd: false })).toBe('cli');
    expect(classifyInvocation([], { INVOCATION_ID: 'abc' })).toBe('cli');
  });

  /**
   * `pm2 startup systemd` runs the PM2 daemon itself under systemd, so a
   * genuinely PM2-managed process can carry `INVOCATION_ID` — inherited from
   * that systemd-started daemon — alongside its own `pm_id`, while its
   * immediate parent is PM2, not systemd (`parentIsSystemd` correctly false).
   * Checking `INVOCATION_ID` before `pm_id` would reject this on the
   * unproven `INVOCATION_ID` alone, without ever reaching the `pm_id`
   * evidence that should have settled it — regression for exactly that.
   */
  it('trusts pm_id even when an inherited, unproven INVOCATION_ID is also present', () => {
    expect(isSupervised({ INVOCATION_ID: 'abc', pm_id: '0' })).toBe(true);
    expect(isSupervised({ INVOCATION_ID: 'abc', pm_id: '0' }, { parentIsSystemd: false })).toBe(true);
    expect(classifyInvocation([], { INVOCATION_ID: 'abc', pm_id: '0' })).toBe('legacy-boot');
  });

  /** `PM2_HOME` is configuration, not identity: an operator can export it from
   *  a shell profile, where it says nothing about how this process started. */
  it('does not treat PM2_HOME alone as a service launch when a terminal is attached', () => {
    expect(isSupervised({ PM2_HOME: '/pm2' }, { hasTty: true })).toBe(false);
    expect(classifyInvocation([], { PM2_HOME: '/pm2' }, { hasTty: true })).toBe('cli');
  });

  it('leaves an unmarked interactive invocation alone', () => {
    expect(isSupervised({})).toBe(false);
    expect(isSupervised({}, { hasTty: true })).toBe(false);
  });
});

/**
 * `isDirectSystemdChild` is what actually computes `parentIsSystemd` in
 * production (see `resolveInvocationSignals` in src/cli/command-names.ts) —
 * the specs above assume it works and just feed it the boolean. These pin
 * the function itself, with an injected `readComm` rather than the live
 * `/proc/1/comm`: real pid 1 is only genuinely systemd on a systemd-based
 * host, so asserting against the live file would pass or fail depending on
 * where the suite happens to run (a Docker devcontainer's pid 1 is commonly
 * tini or dumb-init, not systemd).
 */
describe('isDirectSystemdChild', () => {
  it('has no special-cased shortcut for pid 1 — a non-systemd pid 1 is rejected', () => {
    // Regression: an earlier version of this function trusted `ppid === 1`
    // unconditionally, without checking comm — exactly the false-positive
    // class this PR fixes, reopened inside a container whose pid 1 is
    // tini/dumb-init/s6 rather than systemd.
    expect(isDirectSystemdChild(1, () => 'tini')).toBe(false);
  });

  it('accepts pid 1 when its comm really is systemd', () => {
    expect(isDirectSystemdChild(1, () => 'systemd')).toBe(true);
  });

  it('rejects a parent whose comm is not systemd', () => {
    expect(isDirectSystemdChild(4242, () => 'bash')).toBe(false);
  });

  it('accepts a systemd --user manager at an arbitrary, non-1 pid', () => {
    expect(isDirectSystemdChild(4242, () => 'systemd')).toBe(true);
  });

  it('rejects a pid whose comm cannot be read, without throwing', () => {
    expect(
      isDirectSystemdChild(999999999, () => {
        throw new Error('ENOENT');
      }),
    ).toBe(false);
  });

  it('defaults to the real /proc read and process.ppid when not overridden', () => {
    // No assertion on the outcome (host-dependent) — just that it runs
    // against the live process without an injected reader and never throws.
    expect(() => isDirectSystemdChild()).not.toThrow();
  });
});

/**
 * Shared by src/entry.ts and src/index.ts (see the comment on the export) so
 * the hasTty/parentIsSystemd construction can't drift between the two
 * `classifyInvocation()` call sites the way it briefly did in review.
 */
describe('resolveInvocationSignals', () => {
  it('skips the parentIsSystemd check entirely when INVOCATION_ID is absent', () => {
    expect(resolveInvocationSignals({})).toEqual({ hasTty: expect.any(Boolean), parentIsSystemd: undefined });
  });

  it('computes parentIsSystemd when INVOCATION_ID is present', () => {
    const signals = resolveInvocationSignals({ INVOCATION_ID: 'abc' });
    expect(typeof signals.parentIsSystemd).toBe('boolean');
  });
});

describe('claimSupervisorEnv', () => {
  it('records the supervisor and marks descendants', () => {
    const env: NodeJS.ProcessEnv = { INVOCATION_ID: 'abc' };
    claimSupervisorEnv(env);
    expect(env[SUPERVISOR_MARKER]).toBe('systemd');
    expect(env[CHILD_MARKER]).toBe('1');
    expect(env.INVOCATION_ID).toBeUndefined();
  });

  it('records pm2 from either of its markers', () => {
    const viaId: NodeJS.ProcessEnv = { pm_id: '0' };
    claimSupervisorEnv(viaId);
    expect(viaId[SUPERVISOR_MARKER]).toBe('pm2');
    expect(viaId.pm_id).toBeUndefined();

    const viaHome: NodeJS.ProcessEnv = { PM2_HOME: '/pm2' };
    claimSupervisorEnv(viaHome);
    expect(viaHome[SUPERVISOR_MARKER]).toBe('pm2');
  });

  /**
   * `PM2_HOME` is where PM2 keeps its data, not a launch marker. The gateway
   * spawns agents with shells, so deleting it would silently point any `pm2`
   * they run — including `claude-gateway service status` — at the default
   * `~/.pm2` rather than the configured one. `CHILD_MARKER` already stops it
   * being misread, so there is nothing to gain by removing it.
   */
  it('leaves PM2_HOME in place for the processes it spawns', () => {
    const env: NodeJS.ProcessEnv = { PM2_HOME: '/custom/pm2', pm_id: '0' };
    claimSupervisorEnv(env);
    expect(env.PM2_HOME).toBe('/custom/pm2');
    // …and the descendant that inherits it is still classified as a CLI.
    expect(isSupervised(env as never)).toBe(false);
  });

  it('marks descendants even when no supervisor started us', () => {
    const env: NodeJS.ProcessEnv = {};
    claimSupervisorEnv(env);
    expect(env[SUPERVISOR_MARKER]).toBeUndefined();
    expect(env[CHILD_MARKER]).toBe('1');
  });
});
