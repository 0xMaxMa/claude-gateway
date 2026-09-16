import childProcess = require('child_process');
import { checkDependencies, repairVoiceDependencies } from '../../../src/cli/dependencies';

describe('doctor dependencies', () => {
  it('accepts supported Node and working startup tools', async () => {
    const run = jest.fn(async (file: string) => `${file} version 1.2.3\nAdditional version details`);
    const checks = await checkDependencies({ run, nodeVersion: '22.23.2' });
    expect(checks.every(check => check.ok)).toBe(true);
    expect(checks.filter(check => check.required).map(check => check.name)).toEqual(['node', 'claude', 'bun']);
  });
  it('checks startup and voice tools without attempting an install', async () => {
    const run = jest.fn(async (file: string) => { if (file === 'ffmpeg') throw new Error('missing'); return `${file} version`; });
    const checks = await checkDependencies({ run, nodeVersion: '20.0.0' });
    expect(checks.find(c => c.name === 'node')).toMatchObject({ ok: false, required: true });
    expect(checks.find(c => c.name === 'ffmpeg')).toMatchObject({ ok: false, required: false });
    expect(run.mock.calls.map(call => call[0])).toEqual(['claude', 'bun', 'ffmpeg', 'ffprobe']);
  });
  it('does nothing if both tools already work', async () => {
    const run = jest.fn(async () => 'version');
    expect((await repairVoiceDependencies({ run })).ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('installs only the fixed ffmpeg package with non-interactive sudo and rechecks both binaries', async () => {
    let installed = false;
    const run = jest.fn(async (file: string) => {
      if (file === 'sudo') { installed = true; return ''; }
      if (file === 'apt-get' || installed) return 'version';
      throw new Error('missing');
    });
    expect((await repairVoiceDependencies({ run, platform: 'linux', uid: 1000 })).ok).toBe(true);
    expect(run).toHaveBeenCalledWith('sudo', ['-n', 'apt-get', 'install', '-y', 'ffmpeg'], 120000);
    expect(run.mock.calls.filter(call => call[0] === 'sudo')).toHaveLength(2);
    expect(run).toHaveBeenNthCalledWith(4, 'sudo', ['-n', 'apt-get', 'update'], 120000);
  });
  it('coalesces simultaneous repair requests into one installation', async () => {
    let installed = false;
    let finish!: () => void;
    const barrier = new Promise<void>(resolve => { finish = resolve; });
    const run = jest.fn(async (file: string) => {
      if (file === 'brew') { await barrier; installed = true; return ''; }
      if (installed) return 'version';
      throw new Error('missing');
    });
    const first = repairVoiceDependencies({ run, platform: 'darwin' });
    const second = repairVoiceDependencies({ run, platform: 'darwin' });
    expect(first).toBe(second);
    finish();
    expect((await first).ok).toBe(true);
    expect(run.mock.calls.filter(call => call[0] === 'brew')).toHaveLength(1);
  });
  it('gives manual instructions when privilege escalation fails', async () => {
    const run = jest.fn(async (file: string) => { if (file === 'apt-get') return 'version'; throw new Error('denied'); });
    const result = await repairVoiceDependencies({ run, platform: 'linux', uid: 1000 });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('sudo apt-get install -y ffmpeg');
  });
  it('does not claim success just because a package manager exits successfully', async () => {
    const run = jest.fn(async (file: string) => { if (file === 'brew') return ''; throw new Error('missing'); });
    const result = await repairVoiceDependencies({ run, platform: 'darwin' });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('still unavailable');
  });
  it('stops before install if refreshing apt indexes fails', async () => {
    const run = jest.fn(async (file: string, args: string[]) => {
      if (file === 'apt-get' && args[0] === '--version') return 'apt';
      throw new Error('offline');
    });
    expect((await repairVoiceDependencies({ run, platform: 'linux', uid: 0 })).ok).toBe(false);
    expect(run).toHaveBeenCalledWith('apt-get', ['update'], 120000);
    expect(run.mock.calls.some(call => call[1].includes('install'))).toBe(false);
  });
  it('provides interrupted dpkg recovery guidance without another install attempt', async () => {
    const run = jest.fn(async (file: string, args: string[]) => {
      if (file === 'apt-get') return 'version';
      if (file === 'sudo' && args.includes('install')) throw Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' });
      if (file === 'sudo') return '';
      throw new Error('missing');
    });
    const result = await repairVoiceDependencies({ run, platform: 'linux', uid: 1000 });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('sudo dpkg --configure -a');
    expect(result.detail).toContain('may still be running');
    expect(result.detail).toContain('do not remove lock files');
  });
  it('bounds a stuck package command without force killing it', async () => {
    jest.useFakeTimers();
    const child = { kill: jest.fn(), unref: jest.fn(), stdin: { destroy: jest.fn(), end: jest.fn() }, stdout: { destroy: jest.fn() }, stderr: { destroy: jest.fn() } };
    const spy = jest.spyOn(childProcess, 'execFile').mockImplementation(((file: string, _args: string[], _options: unknown, callback: Function) => {
      if (file !== 'brew') callback(Object.assign(new Error('missing'), { code: 'ENOENT' }));
      return child;
    }) as any);
    try {
      const result = repairVoiceDependencies({ platform: 'darwin' });
      await jest.advanceTimersByTimeAsync(121000);
      expect((await result).detail).toContain('Homebrew processes may still be running');
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
      expect(child.unref).toHaveBeenCalled();
      expect(spy.mock.calls.find(call => call[0] === 'brew')?.[2]).toMatchObject({ timeout: 120000, killSignal: 'SIGTERM' });
    } finally { spy.mockRestore(); jest.useRealTimers(); }
  });
  it('never attempts unsupported system installation', async () => {
    const run = jest.fn(async () => { throw new Error('missing'); });
    expect((await repairVoiceDependencies({ run, platform: 'win32' })).ok).toBe(false);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
