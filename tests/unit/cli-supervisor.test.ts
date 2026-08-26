import { isSupervised, claimSupervisorEnv, classifyInvocation, CHILD_MARKER, SUPERVISOR_MARKER } from '../../src/cli/command-names';

/**
 * The supervisor markers are inherited by every descendant, and the gateway
 * spawns agents that have shells. These specs pin the two things that keeps
 * straight: a descendant can never be mistaken for a service main process, and
 * a real service main process is still recognised as one.
 */
describe('supervisor detection', () => {
  it('treats a child of the gateway as a CLI invocation, whatever else it inherited', () => {
    expect(isSupervised({ INVOCATION_ID: 'abc', [CHILD_MARKER]: '1' })).toBe(false);
    expect(isSupervised({ PM2_HOME: '/pm2', [CHILD_MARKER]: '1' })).toBe(false);
    expect(isSupervised({ pm_id: '0', [CHILD_MARKER]: '1' })).toBe(false);
  });

  it('recognises a service main process', () => {
    expect(isSupervised({ INVOCATION_ID: 'abc' })).toBe(true);
    expect(isSupervised({ pm_id: '0' })).toBe(true);
    expect(isSupervised({ PM2_HOME: '/pm2' })).toBe(true);
  });

  /**
   * `INVOCATION_ID` and `pm_id` are minted per invocation by the supervisor and
   * cannot come from a shell profile, so a terminal does not overrule them — a
   * legacy unit with `StandardInput=tty` must still boot rather than printing
   * help at its service manager.
   */
  it('still boots a supervised launch that happens to have a terminal', () => {
    expect(isSupervised({ INVOCATION_ID: 'abc' }, { hasTty: true })).toBe(true);
    expect(isSupervised({ pm_id: '0' }, { hasTty: true })).toBe(true);
    expect(classifyInvocation([], { INVOCATION_ID: 'abc' }, { hasTty: true })).toBe('legacy-boot');
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
