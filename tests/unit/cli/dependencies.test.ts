import childProcess = require('child_process');
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveCodexRuntime } from '../../../src/session/codex-runtime';
import { checkDependencies, repairVoiceDependencies } from '../../../src/cli/dependencies';

jest.mock('../../../src/session/codex-runtime', () => ({ resolveCodexRuntime: jest.fn() }));

describe('doctor dependencies', () => {
  beforeEach(() => {
    (resolveCodexRuntime as jest.Mock).mockReset().mockImplementation((bin?: string) => ({ executable: bin ?? '/tools/codex', mounts: [], containerExecutable: '/usr/local/bin/codex', fingerprint: 'test' }));
  });
  it('accepts supported Node and working startup tools', async () => {
    const run = jest.fn(async (file: string) => file === '/tools/codex' ? 'codex-cli 0.154.0' : `${file} version 1.2.3\nAdditional version details`);
    const checks = await checkDependencies({ run, nodeVersion: '22.23.2' });
    expect(checks.every(check => check.ok)).toBe(true);
    expect(checks.filter(check => check.required).map(check => check.name)).toEqual(['node', 'claude', 'bun']);
  });
  it('checks startup and voice tools without attempting an install', async () => {
    const run = jest.fn(async (file: string) => { if (file === 'ffmpeg') throw new Error('missing'); return `${file} version`; });
    const checks = await checkDependencies({ run, nodeVersion: '20.0.0' });
    expect(checks.find(c => c.name === 'node')).toMatchObject({ ok: false, required: true });
    expect(checks.find(c => c.name === 'ffmpeg')).toMatchObject({ ok: false, required: false });
    expect(run.mock.calls.map(call => call[0])).toEqual(['claude', 'bun', 'ffmpeg', 'ffprobe', '/tools/codex']);
  });
  it('reports missing optional Codex with service PATH guidance and never installs it', async () => {
    (resolveCodexRuntime as jest.Mock).mockImplementation(() => { throw new Error('missing PRIVATE_VALUE'); });
    const run = jest.fn(async () => 'version');
    const checks = await checkDependencies({ run });
    expect(checks.find(check => check.name === 'codex')).toMatchObject({ ok: false, required: false });
    expect(checks.find(check => check.name === 'codex')?.detail).toContain('service PATH may differ');
    expect(JSON.stringify(checks)).not.toContain('PRIVATE_VALUE');
    expect(run).toHaveBeenCalledTimes(4);
  });
  it('reports host version separately from incompatible container runtime', async () => {
    (resolveCodexRuntime as jest.Mock).mockReturnValue({ executable: '/tools/codex', containerError: 'private layout error' });
    const checks = await checkDependencies({ run: async () => 'codex-cli 0.154.0\nPRIVATE_OUTPUT' });
    expect(checks.find(check => check.name === 'codex')).toMatchObject({ ok: true, required: false });
    expect(checks.find(check => check.name === 'codex')?.detail).toContain('executable "/tools/codex"');
    expect(checks.find(check => check.name === 'codexContainer')).toMatchObject({ ok: false, required: false });
    expect(JSON.stringify(checks)).not.toMatch(/PRIVATE_OUTPUT|private layout error/);
  });
  it('escapes and bounds the resolved executable path in local diagnostics', async () => {
    (resolveCodexRuntime as jest.Mock).mockReturnValue({ executable: `/tools/\n\u001b[31m${'a'.repeat(300)}` });
    const checks = await checkDependencies({ run: async () => 'codex-cli 0.154.0' });
    const detail = checks.find(check => check.name === 'codex')!.detail;
    expect(detail).toContain('executable "/tools/\\n\\u001b[31m');
    expect(detail).not.toMatch(/[\n\u001b]/);
    expect(detail).not.toContain('a'.repeat(240));
    expect(detail).toContain('..."');
  });
  it('checks gateway and effective overridden agent selections without revealing config credentials', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-doctor-'));
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ gateway: { workers: { codex: { bin: '/global/codex' } }, api: { keys: ['PRIVATE_KEY'] } },
      agents: [{ id: 'PRIVATE_AGENT' }, { workers: { codex: { bin: '/agent/codex' } } }, { workers: { codex: { bin: '/agent/codex' } } }] }));
    try {
      const run = jest.fn(async () => 'codex-cli 0.154.0');
      const checks = await checkDependencies({ run, configPath });
      expect(resolveCodexRuntime).toHaveBeenCalledTimes(2);
      expect(resolveCodexRuntime).toHaveBeenNthCalledWith(1, '/global/codex', process.cwd());
      expect(resolveCodexRuntime).toHaveBeenNthCalledWith(2, '/agent/codex', process.cwd());
      expect(JSON.stringify(checks)).not.toMatch(/PRIVATE_KEY|PRIVATE_AGENT/);
      expect(checks.find(check => check.name === 'codex:gateway')?.detail).toContain('agents[0]');
      expect(checks.find(check => check.name === 'codex:agents[1]')?.detail).toContain('agents[2]');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('resolves a relative override in the configured agent workspace', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-doctor-relative-'));
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ gateway: {}, agents: [{ workspace: '/agent workspace', workers: { codex: { bin: './bin/codex' } } }] }));
    try {
      await checkDependencies({ configPath, run: async () => 'codex-cli 0.154.0' });
      expect(resolveCodexRuntime).toHaveBeenCalledWith('./bin/codex', '/agent workspace');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('warns on unreadable config and still checks the default executable', async () => {
    const checks = await checkDependencies({ configPath: '/nonexistent/codex-doctor/config.json', run: async () => 'codex-cli 0.154.0' });
    expect(checks.find(check => check.name === 'codexConfig')).toMatchObject({ ok: false, required: false });
    expect(resolveCodexRuntime).toHaveBeenCalledWith(undefined, process.cwd());
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

it('coalesces identical inherited Codex checks across different agent workspaces',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-doctor-group-'));
 try {
  const configPath=path.join(dir,'config.json');
  fs.writeFileSync(configPath,JSON.stringify({gateway:{},agents:Array.from({length:20},(_,i)=>({workspace:'/agent/'+i}))}));
  const before=(resolveCodexRuntime as jest.Mock).mock.calls.length;
  const checks=await checkDependencies({configPath,run:async()=> 'codex-cli 0.155.1'});
  expect((resolveCodexRuntime as jest.Mock).mock.calls.length-before).toBe(1);
  expect(checks.find(c=>c.name==='codex')?.detail).toContain('20 agents (shared configuration)');
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
