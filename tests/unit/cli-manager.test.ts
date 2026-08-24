import { detectManager } from '../../src/cli/manager';

describe('cli manager detectManager', () => {
  it('detects systemd when the unit is active', () => {
    const m = detectManager({
      exec: (cmd) => {
        if (cmd.includes('systemctl is-active')) return 'active\n';
        throw new Error('nope');
      },
    });
    expect(m).toBe('systemd');
  });

  it('detects pm2 when systemd is inactive but pm2 has the process', () => {
    const m = detectManager({
      exec: (cmd) => {
        if (cmd.includes('systemctl')) return 'inactive\n';
        if (cmd.includes('pm2 pid gateway')) return '12345\n';
        throw new Error('nope');
      },
    });
    expect(m).toBe('pm2');
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
      exec: (cmd) => {
        if (cmd.includes('systemctl')) return 'inactive';
        if (cmd.includes('pm2')) return '\n'; // pm2 prints empty when process missing
        throw new Error('none');
      },
      readPidfile: () => null,
    });
    expect(m).toBe('unknown');
  });
});
