import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { probeCliSkills } from '../../../src/orchestration/cli-skills';
import { probeMcpConfiguration } from '../../../src/orchestration/capabilities';
import { recordProcessRoot, terminateProbeTree } from '../../../src/orchestration/process-supervisor';
import { setProcessPlatform, type ProcessPlatform } from '../../../src/orchestration/process-platform';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (check: () => boolean, ms = 30000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 50)); } };

// Runs natively on Linux, macOS and Windows (cross-platform CI): a probe that
// never answers starts a helper, and its timeout must stop that grandchild too.
describe('probe timeouts stop the whole process tree', () => {
  let dir: string;
  beforeEach(() => { setProcessPlatform(undefined); dir = mkdtempSync(join(tmpdir(), 'probe-tree-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const hangingProbe = (pidfile: string) => [
    '-e',
    `const {spawn}=require('child_process');const fs=require('fs');
     const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
     fs.writeFileSync(${JSON.stringify(pidfile)},String(g.pid));setInterval(()=>{},1000);`,
  ];
  const expectTreeStopped = async (pidfile: string) => {
    expect(existsSync(pidfile)).toBe(true);
    const grandchild = Number(readFileSync(pidfile, 'utf8'));
    await until(() => !alive(grandchild));
  };

  test('CLI skill discovery', async () => {
    const pidfile = join(dir, 'grandchild.pid');
    await expect(probeCliSkills(process.execPath, hangingProbe(pidfile), dir, 4000)).rejects.toThrow('CLI_SKILL_DISCOVERY_TIMEOUT');
    await expectTreeStopped(pidfile);
  }, 60000);

  test('MCP configuration probe', async () => {
    const pidfile = join(dir, 'grandchild.pid');
    await expect(probeMcpConfiguration(process.execPath, hangingProbe(pidfile), dir, undefined, 4000)).rejects.toThrow('CAPABILITY_DISCOVERY_TIMEOUT');
    await expectTreeStopped(pidfile);
  }, 60000);
});

describe('terminateProbeTree', () => {
  afterEach(() => setProcessPlatform(undefined));
  const platform = (overrides: Partial<ProcessPlatform>): ProcessPlatform => ({
    detachWorkers: false, termGraceMs: 0, pollMs: 0, killSettleMs: 0,
    groupMembers: jest.fn(async () => [10, 11]), signalGroup: jest.fn(async () => true),
    fingerprint: jest.fn(async () => undefined), bootId: jest.fn(async () => undefined), snapshot: jest.fn(async () => undefined), ...overrides,
  });
  const child = () => ({ pid: 10, exitCode: null as number | null, signalCode: null, kill: jest.fn(() => true) });

  test('POSIX signals the probe process group', async () => {
    const p = platform({ detachWorkers: true });
    setProcessPlatform(p);
    const c = child();
    await terminateProbeTree(c, 'SIGTERM');
    expect(p.signalGroup).toHaveBeenCalledWith(10, 'SIGTERM');
    expect(c.kill).not.toHaveBeenCalled();
  });

  // Windows: the root identity is recorded once at spawn (recordProcessRoot), so
  // SIGTERM costs no snapshot and SIGKILL kills the tree of exactly that identity.

  test('Windows: SIGTERM takes no snapshot; SIGKILL kills the recorded tree once', async () => {
    const c = child();
    const p = platform({ adopt: jest.fn(async () => '1000') });
    setProcessPlatform(p);
    recordProcessRoot(c);
    await terminateProbeTree(c, 'SIGTERM');
    expect(p.groupMembers).not.toHaveBeenCalled();
    expect(p.snapshot).not.toHaveBeenCalled();
    expect(p.signalGroup).not.toHaveBeenCalled();
    await Promise.all([terminateProbeTree(c, 'SIGKILL'), terminateProbeTree(c, 'SIGKILL')]);
    expect(p.groupMembers).not.toHaveBeenCalled();
    expect(p.signalGroup).toHaveBeenCalledTimes(1);
    expect(p.signalGroup).toHaveBeenCalledWith(10, 'SIGKILL', '1000');
    expect(c.kill).not.toHaveBeenCalled();
  });

  test('Windows: a probe that exited before its identity was recorded is never signalled (PID reuse)', async () => {
    const c = { ...child(), exitCode: 0 };
    const p = platform({ adopt: jest.fn(async () => undefined) });
    setProcessPlatform(p);
    recordProcessRoot(c);
    await terminateProbeTree(c, 'SIGKILL');
    expect(p.signalGroup).not.toHaveBeenCalled();
    expect(c.kill).not.toHaveBeenCalled();
  });

  test('Windows: an unrecorded probe is only killed through its own handle', async () => {
    const p = platform({});
    setProcessPlatform(p);
    const c = child();
    await terminateProbeTree(c, 'SIGKILL');
    expect(p.groupMembers).not.toHaveBeenCalled();
    expect(p.signalGroup).not.toHaveBeenCalled();
    expect(c.kill).toHaveBeenCalledWith('SIGKILL');
  });

  test('Windows: falls back to the root when the tree cannot be proven', async () => {
    const p = platform({ signalGroup: jest.fn(async () => false), adopt: jest.fn(async () => '1000') });
    setProcessPlatform(p);
    const c = child();
    recordProcessRoot(c);
    await terminateProbeTree(c, 'SIGKILL');
    expect(c.kill).toHaveBeenCalledWith('SIGKILL');
  });

  test('Windows: both probes record their root at spawn, while the handle is held', async () => {
    const pids: number[] = [];
    setProcessPlatform(platform({ adopt: jest.fn(async (pid: number, alive: () => boolean) => { expect(alive()).toBe(true); pids.push(pid); return undefined; }) }));
    const cwd = tmpdir();
    await expect(probeCliSkills(process.execPath, ['-e', 'process.exit(0)'], cwd, 4000)).rejects.toThrow('CLI_SKILL_DISCOVERY_UNAVAILABLE');
    await expect(probeMcpConfiguration(process.execPath, ['-e', 'process.exit(0)'], cwd, undefined, 4000)).rejects.toThrow('CAPABILITY_DISCOVERY_UNAVAILABLE');
    expect(pids).toHaveLength(2);
    expect(pids.every(pid => pid > 0)).toBe(true);
  }, 30000);

  test('Windows: a probe that answers and exits on stdin EOF within the grace period still has its helpers killed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe-close-'));
    const pidfile = join(dir, 'helper.pid');
    let helper = 0;
    // SIGTERM is a no-op on Windows; only the SIGKILL tree kill reaches the helper.
    const signalGroup = jest.fn(async (_group: number, signal: string) => {
      if (signal === 'SIGKILL') { helper = Number(readFileSync(pidfile, 'utf8')); try { process.kill(helper, 'SIGKILL'); } catch { /* already gone */ } }
      return true;
    });
    setProcessPlatform(platform({ signalGroup, adopt: jest.fn(async () => '1000') }));
    const probe = `const {spawn}=require('child_process');const fs=require('fs');
      const h=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});h.unref();
      fs.writeFileSync(${JSON.stringify(pidfile)},String(h.pid));
      let b='';process.stdin.on('data',d=>{b+=d;const i=b.indexOf('\\n');if(i<0)return;const id=JSON.parse(b.slice(0,i)).request_id;
        process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:id,response:{commands:[]}}})+'\\n');});
      process.stdin.on('end',()=>process.exit(0));`;
    try {
      await expect(probeCliSkills(process.execPath, ['-e', probe], dir, 10000)).resolves.toEqual([]);
      await until(() => signalGroup.mock.calls.some(([, signal]) => signal === 'SIGKILL'), 5000);
      expect(signalGroup).toHaveBeenCalledTimes(1);
      expect(signalGroup).toHaveBeenCalledWith(expect.any(Number), 'SIGKILL', '1000');
      await until(() => !alive(helper));
    } finally {
      if (existsSync(pidfile)) { try { process.kill(Number(readFileSync(pidfile, 'utf8')), 'SIGKILL'); } catch { /* stopped */ } }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test('unsupported hosts kill the root', async () => {
    setProcessPlatform(null);
    const c = child();
    await terminateProbeTree(c, 'SIGTERM');
    expect(c.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
