import { detectManager, localGatewayIsLive, readLocalGateway, pidLooksLikeGateway } from '../../src/cli/manager';

describe('cli manager detectManager', () => {
  it('detects the user service first — `service install` creates a user unit', () => {
    const m = detectManager({
      exec: (args) => {
        if (args.join(' ') === 'systemctl --user is-active claude-gateway.service') return 'active\n';
        throw new Error('nope');
      },
    });
    expect(m).toBe('systemd-user');
  });

  it('falls back to a system-scoped unit (externally installed) when no user unit is active', () => {
    const m = detectManager({
      exec: (args) => {
        if (args.includes('--user')) return 'inactive\n';
        if (args.join(' ') === 'systemctl is-active claude-gateway.service') return 'active\n';
        throw new Error('nope');
      },
    });
    expect(m).toBe('systemd-system');
  });

  it('detects pm2 when systemd is inactive but pm2 has the process', () => {
    const m = detectManager({
      exec: (args) => {
        if (args[0] === 'systemctl') return 'inactive\n';
        if (args.join(' ') === 'pm2 pid gateway') return '12345\n';
        throw new Error('nope');
      },
    });
    expect(m).toBe('pm2');
  });

  it('never builds a shell string — every probe is a fixed argv array', () => {
    const seen: string[][] = [];
    detectManager({
      exec: (args) => {
        seen.push(args);
        throw new Error('none');
      },
      readPidfile: () => null,
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const args of seen) {
      expect(Array.isArray(args)).toBe(true);
      for (const token of args) expect(token).not.toMatch(/[;&|`$]/);
    }
  });

  it('falls back to foreground when a live pid is in the pidfile', () => {
    const m = detectManager({
      exec: () => {
        throw new Error('no systemd/pm2');
      },
      pidfilePath: '/tmp/fake.pid',
      readPidfile: () => '4242',
      isAlive: (pid) => pid === 4242,
    });
    expect(m).toBe('foreground');
  });

  it('returns unknown when the pidfile pid is dead', () => {
    const m = detectManager({
      exec: () => {
        throw new Error('none');
      },
      readPidfile: () => '999999',
      isAlive: () => false,
    });
    expect(m).toBe('unknown');
  });

  it('returns unknown when nothing is detectable', () => {
    const m = detectManager({
      exec: () => {
        throw new Error('none');
      },
      readPidfile: () => null,
    });
    expect(m).toBe('unknown');
  });

  it('treats a non-numeric pm2 pid as not-pm2', () => {
    const m = detectManager({
      exec: (args) => {
        if (args[0] === 'systemctl') return 'inactive';
        if (args[0] === 'pm2') return '\n'; // pm2 prints empty when process missing
        throw new Error('none');
      },
      readPidfile: () => null,
    });
    expect(m).toBe('unknown');
  });
});

/**
 * `resolveUrl()` consults this on every CLI invocation, so it must stay a file
 * read plus a signal-0 — never a subprocess.
 */
describe('localGatewayIsLive', () => {
  it('is true for a pidfile naming a live process', () => {
    expect(localGatewayIsLive({ readPidfile: () => '4242\n', isAlive: (pid) => pid === 4242 })).toBe(true);
  });

  it('is false when the pidfile is missing, empty, junk, or names a dead process', () => {
    expect(localGatewayIsLive({ readPidfile: () => null, isAlive: () => true })).toBe(false);
    expect(localGatewayIsLive({ readPidfile: () => '', isAlive: () => true })).toBe(false);
    expect(localGatewayIsLive({ readPidfile: () => 'not-a-pid', isAlive: () => true })).toBe(false);
    expect(localGatewayIsLive({ readPidfile: () => '0', isAlive: () => true })).toBe(false);
    expect(localGatewayIsLive({ readPidfile: () => '4242', isAlive: () => false })).toBe(false);
  });
});

describe('readLocalGateway', () => {
  it('reads the pid and the port the gateway recorded', () => {
    expect(readLocalGateway({ readPidfile: () => '4242\n9000\n', isAlive: (pid) => pid === 4242 })).toEqual({ pid: 4242, port: 9000 });
  });

  /** A pidfile written before the port line existed still identifies a live
   *  gateway; only the port is unknown, and callers fall back to $PORT. */
  it('reports no port for a pid-only pidfile', () => {
    expect(readLocalGateway({ readPidfile: () => '4242\n', isAlive: () => true })).toEqual({ pid: 4242, port: undefined });
  });

  it('ignores a port that cannot be dialled', () => {
    // 0 means "the OS picks" and is never an address; the rest is junk.
    for (const line of ['0', '-1', '70000', 'not-a-port', '']) {
      expect(readLocalGateway({ readPidfile: () => `4242\n${line}\n`, isAlive: () => true })?.port).toBeUndefined();
    }
  });

  it('is null when the pidfile is missing, junk, or names a dead process', () => {
    expect(readLocalGateway({ readPidfile: () => null, isAlive: () => true })).toBeNull();
    expect(readLocalGateway({ readPidfile: () => 'not-a-pid\n9000', isAlive: () => true })).toBeNull();
    expect(readLocalGateway({ readPidfile: () => '4242\n9000', isAlive: () => false })).toBeNull();
  });
});

/**
 * pidLooksLikeGateway() — the guard `gateway stop|restart` uses before it
 * signals the pid in the pidfile. readLocalGateway() stops at signal-0, which
 * only proves *something* holds that pid; a gateway lost to SIGKILL or the OOM
 * killer leaves its pidfile behind, and once the kernel recycles the pid,
 * stopping "the gateway" would terminate a stranger.
 */
describe('pidLooksLikeGateway', () => {
  // U-MG-375a
  it('U-MG-375a: recognises the installed binary and a checkout entry point', () => {
    const cases = [
      'node /usr/lib/node_modules/@0xmaxma/claude-gateway/dist/entry.js gateway start',
      '/usr/local/bin/claude-gateway gateway start',
      'node /opt/gw/dist/index.js gateway start',
      'ts-node /opt/gw/src/index.ts gateway start',
    ];
    for (const cmdline of cases) {
      expect(pidLooksLikeGateway(4242, { readCmdline: () => cmdline })).toBe(true);
    }
  });

  // U-MG-375b — the case the guard exists for.
  it('U-MG-375b: rejects an unrelated process that inherited the pid', () => {
    const cases = ['/usr/bin/postgres -D /var/lib/postgresql', 'sshd: ubuntu@pts/3', 'vim notes.md'];
    for (const cmdline of cases) {
      expect(pidLooksLikeGateway(4242, { readCmdline: () => cmdline })).toBe(false);
    }
  });

  // U-MG-375c — an unverifiable pid is treated as not-a-gateway: the cost of
  // guessing wrong is killing someone else's process, so silence means no.
  it('U-MG-375c: an unreadable command line is not a gateway', () => {
    expect(pidLooksLikeGateway(4242, { readCmdline: () => null })).toBe(false);
    expect(pidLooksLikeGateway(4242, { readCmdline: () => '' })).toBe(false);
  });
});
