import { detectManager } from '../../src/cli/manager';

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
