import { spawn } from 'child_process';
import { once } from 'events';
import { liveGroupMembers, stopProcessGroup } from '../../../src/orchestration/process-supervisor';

(process.platform === 'linux' ? test : test.skip)('running cancellation confirms the owned process group stopped, including a child', async () => {
  const child = spawn(process.execPath, ['-e', `require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)`], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await once(child.stdout!, 'data');
    expect(liveGroupMembers(child.pid!)!.length).toBeGreaterThanOrEqual(2);
    expect(await stopProcessGroup(child.pid!)).toBe(true);
    expect(liveGroupMembers(child.pid!)).toEqual([]);
  } finally { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already stopped */ } }
});

import { cleanupPersistedProcess, processFingerprint } from '../../../src/orchestration/process-supervisor';
(process.platform === 'linux' ? test : test.skip)('persisted cleanup refuses a reused PID, stops a verified group, and accepts an already exited legacy group', async()=>{
 const child=spawn(process.execPath,['-e',"process.stdout.write('ready');setInterval(()=>{},1000)"],{detached:true,stdio:['ignore','pipe','ignore']});
 try {
  await once(child.stdout!,'data');
  const identity={pid:child.pid!,...processFingerprint(child.pid!)};
  expect(identity.startTicks).toBeTruthy();
  expect(await cleanupPersistedProcess({...identity,startTicks:'wrong'})).toBe(false);
  expect(await cleanupPersistedProcess({pid:child.pid!})).toBe(false);
  expect(liveGroupMembers(child.pid!)!.length).toBeGreaterThan(0);
  expect(await cleanupPersistedProcess(identity)).toBe(true);
  expect(await cleanupPersistedProcess({pid:child.pid!})).toBe(true);
  expect(await cleanupPersistedProcess()).toBe(false);
  expect(await cleanupPersistedProcess({pid:-1})).toBe(false);
 } finally {try{process.kill(-child.pid!,'SIGKILL');}catch{}}
});
