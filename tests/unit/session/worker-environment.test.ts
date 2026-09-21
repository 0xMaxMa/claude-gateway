import { workerEnvironment, validateWorkerEnvironment } from '../../../src/session/worker-environment';
import { validateWorkerHarness } from '../../../src/orchestration/worker-harness';

test('merges host environment by key without modifying user configuration', () => {
  const gateway = { gateway: { workers: { environment: { BASH_ENV:'/hooks/bash', LANG:'C' }, containerEnvironment:{LANG:'container'} } } } as any;
  const agent = {workers:{environment:{LANG:'en_US.UTF-8'}}} as any;
  expect(workerEnvironment(agent,gateway)).toEqual({BASH_ENV:'/hooks/bash',LANG:'en_US.UTF-8'});
  expect(gateway.gateway.workers.environment.LANG).toBe('C');
  expect(workerEnvironment({...agent,type:'app-agent'},gateway)).toEqual({LANG:'container'});
  expect(workerEnvironment({...agent,type:'app-agent',workers:{containerEnvironment:{LANG:'app'}}},gateway)).toEqual({LANG:'app'});
});
test.each([null, [], {A:2},{'BAD-NAME':'a'},{HOME:'/host'},{CODEX_HOME:'/host'},{GATEWAY_TASK_ID:'fake'},{BASH_ENV:'bad\0path'}])('rejects invalid/reserved environment %j', value => {
  expect(()=>validateWorkerEnvironment(value,'workers.environment')).toThrow();
});
test('accepts explicit startup hooks, applies validation without codex configuration', () => {
  expect(()=>validateWorkerHarness({environment:{BASH_ENV:'/hooks/bash',ZDOTDIR:'/hooks/zsh'}})).not.toThrow();
  expect(()=>validateWorkerHarness({environment:{CODEX_HOME:'/host'}})).toThrow();
  expect(()=>validateWorkerHarness({containerEnvironment:{HOME:'/host'}})).toThrow();
  expect(workerEnvironment({} as any,{gateway:{}} as any)).toEqual({});
});
