import { spawn } from 'child_process';
import { once } from 'events';
import { cleanupPersistedProcess, liveGroupMembers, processFingerprint, stopProcessGroup, workerSpawnDetached } from '../../../src/orchestration/process-supervisor';

// Runs against the real supervisor of this host: /proc on Linux, ps on macOS,
// CIM + taskkill on Windows. The child is spawned exactly as a worker is.
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
