import { SessionCompactionScheduler } from '../../src/agent/session-compaction-scheduler';
import { resolveSessionCompaction } from '../../src/orchestration/session-compaction';

jest.mock('../../src/history/cleanup',()=>({msUntilNextTime:()=>1000}));
jest.mock('../../src/agent/dreaming',()=>({agentJitterMs:()=>0}));
beforeEach(()=>jest.useFakeTimers());
afterEach(()=>jest.useRealTimers());
const settings=()=>({config:resolveSessionCompaction({enabled:true}),hour:3,minute:0,timezone:'UTC',stagger:0});
test('config restart while a run is in flight leaves only the new timer',async()=>{
  let finish!:()=>void;
  const run=jest.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
  const scheduler=new SessionCompactionScheduler('a',settings,run,jest.fn());
  scheduler.start();await jest.advanceTimersByTimeAsync(1000);
  expect(run).toHaveBeenCalledTimes(1);
  scheduler.start();finish();await jest.advanceTimersByTimeAsync(0);
  expect(jest.getTimerCount()).toBe(1);
  scheduler.stop();expect(jest.getTimerCount()).toBe(0);
});
test('stopping during a run never rearms the timer and starting again works',async()=>{
  let finish!:()=>void;
  const scheduler=new SessionCompactionScheduler('a',settings,()=>new Promise<void>(r=>finish=r),jest.fn());
  scheduler.start();await jest.advanceTimersByTimeAsync(1000);
  scheduler.stop();finish();await jest.advanceTimersByTimeAsync(0);
  expect(jest.getTimerCount()).toBe(0);expect(scheduler.nextRunAt).toBeNull();
  scheduler.start();expect(jest.getTimerCount()).toBe(1);scheduler.stop();
});
test('failed run is reported and next night remains scheduled',async()=>{
  const failed=jest.fn();const scheduler=new SessionCompactionScheduler('a',settings,async()=>{throw new Error('failure');},failed);
  scheduler.start();await jest.advanceTimersByTimeAsync(1000);
  expect(failed).toHaveBeenCalledTimes(1);expect(jest.getTimerCount()).toBe(1);scheduler.stop();
});
