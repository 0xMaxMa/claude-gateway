import { spawn } from 'child_process';
import { once } from 'events';
import { cleanupPersistedProcess, liveGroupMembers, processFingerprint, stopProcessGroup, workerSpawnDetached } from '../../../src/orchestration/process-supervisor';

// Runs against the real supervisor of this host: /proc on Linux, ps on macOS,
// WMI + taskkill on Windows. The child is spawned exactly as a worker is.
const supported = ['linux', 'darwin', 'win32'].includes(process.platform);
const forceKill = (pid: number) => { try { process.kill(workerSpawnDetached() ? -pid : pid, 'SIGKILL'); } catch { /* already stopped */ } };

(supported ? test : test.skip)('running cancellation confirms the owned process group stopped, including a child', async () => {
  const child = spawn(process.execPath, ['-e', `require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)`], { detached: workerSpawnDetached(), stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await once(child.stdout!, 'data');
    expect((await liveGroupMembers(child.pid!))!.length).toBeGreaterThanOrEqual(2);
    expect(await stopProcessGroup(child.pid!)).toBe(true);
    expect(await liveGroupMembers(child.pid!)).toEqual([]);
  } finally { forceKill(child.pid!); }
}, 60000);

(supported ? test : test.skip)('persisted cleanup refuses a reused PID, stops a verified group, and accepts an already exited legacy group', async()=>{
 const child=spawn(process.execPath,['-e',"process.stdout.write('ready');setInterval(()=>{},1000)"],{detached:workerSpawnDetached(),stdio:['ignore','pipe','ignore']});
 try {
  await once(child.stdout!,'data');
  const identity={pid:child.pid!,...await processFingerprint(child.pid!)};
  expect(identity.startTicks).toBeTruthy();
  expect(await cleanupPersistedProcess({...identity,startTicks:'wrong'})).toBe(false);
  expect(await cleanupPersistedProcess({pid:child.pid!})).toBe(false);
  expect((await liveGroupMembers(child.pid!))!.length).toBeGreaterThan(0);
  expect(await cleanupPersistedProcess(identity)).toBe(true);
  expect(await cleanupPersistedProcess({pid:child.pid!})).toBe(true);
  expect(await cleanupPersistedProcess()).toBe(false);
  expect(await cleanupPersistedProcess({pid:-1})).toBe(false);
 } finally {forceKill(child.pid!);}
}, 60000);

// A desktop app starts the gateway with a minimal env: no PSModulePath, no module
// analysis cache, a private profile. Cmdlet discovery then took 20-70s, past the
// snapshot timeout, so every worker stop ended unproven (needs_reconciliation).
(process.platform === 'win32' ? test : test.skip)('the Windows snapshot stays fast under a minimal sidecar-like env', async () => {
  const saved = { ...process.env };
  const home = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'minenv-'));
  try {
    for (const key of Object.keys(process.env)) {
      if (!['PATH', 'Path', 'SystemRoot', 'SystemDrive', 'WINDIR', 'windir', 'COMSPEC', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramData'].includes(key)) delete process.env[key];
    }
    Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: `${home}\\AppData\\Roaming`, LOCALAPPDATA: `${home}\\AppData\\Local` });
    const started = Date.now();
    const identity = await processFingerprint(process.pid);
    expect(identity?.startTicks).toMatch(/^\d+$/);
    expect(identity?.bootId).toMatch(/^\d+$/);
    expect(await liveGroupMembers(process.pid)).toContain(process.pid);
    expect(Date.now() - started).toBeLessThan(15000);
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}, 120000);
