import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { probeCliSkills } from '../../../src/orchestration/cli-skills';
import { probeMcpConfiguration } from '../../../src/orchestration/capabilities';
import { terminateProbeTree } from '../../../src/orchestration/process-supervisor';
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
    fingerprint: jest.fn(async () => undefined), snapshot: jest.fn(async () => undefined), ...overrides,
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

  test('Windows: SIGTERM records lineage only; SIGKILL kills the tree once', async () => {
    const p = platform({});
    setProcessPlatform(p);
    const c = child();
    await terminateProbeTree(c, 'SIGTERM');
    expect(p.groupMembers).toHaveBeenCalledTimes(1);
    expect(p.signalGroup).not.toHaveBeenCalled();
    await Promise.all([terminateProbeTree(c, 'SIGKILL'), terminateProbeTree(c, 'SIGKILL')]);
    expect(p.groupMembers).toHaveBeenCalledTimes(1);
    expect(p.signalGroup).toHaveBeenCalledTimes(1);
    expect(p.signalGroup).toHaveBeenCalledWith(10, 'SIGKILL');
  });

  test('Windows: a probe that exits during the lineage snapshot is never signalled (PID reuse)', async () => {
    const c = child();
    const p = platform({ groupMembers: jest.fn(async () => { c.exitCode = 0; return [10]; }) });
    setProcessPlatform(p);
    await terminateProbeTree(c, 'SIGKILL');
    expect(p.signalGroup).not.toHaveBeenCalled();
    expect(c.kill).not.toHaveBeenCalled();
  });

  test('Windows: an already exited probe without lineage is left alone', async () => {
    const p = platform({});
    setProcessPlatform(p);
    const c = { ...child(), exitCode: 1 };
    await terminateProbeTree(c, 'SIGKILL');
    expect(p.groupMembers).not.toHaveBeenCalled();
    expect(p.signalGroup).not.toHaveBeenCalled();
  });

  test('Windows: falls back to the root when the tree cannot be proven', async () => {
    const p = platform({ signalGroup: jest.fn(async () => false) });
    setProcessPlatform(p);
    const c = child();
    await terminateProbeTree(c, 'SIGKILL');
    expect(c.kill).toHaveBeenCalledWith('SIGKILL');
  });

  test('unsupported hosts kill the root', async () => {
    setProcessPlatform(null);
    const c = child();
    await terminateProbeTree(c, 'SIGTERM');
    expect(c.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
