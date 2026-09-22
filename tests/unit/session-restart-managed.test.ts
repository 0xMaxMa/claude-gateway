import { EventEmitter } from 'events';
import { AgentRunner } from '../../src/agent/runner';
import { AgentOrchestrationRuntime } from '../../src/orchestration/runtime';
import { startProcessTurn, type WorkerProcess } from '../../src/orchestration/process-turn';

function fixture() {
  const process = Object.assign(new EventEmitter(), {
    sessionId: 'session', start: async () => {}, sendMessage: () => {},
    interrupt: jest.fn(), stop: jest.fn(async () => { process.emit('exit', 0); }),
  });
  const runtime = Object.create(AgentOrchestrationRuntime.prototype);
  runtime.active = new Map();
  runtime.store = { get: jest.fn(() => undefined) };
  runtime.decisions = { interrupt: jest.fn() };
  const runner = Object.create(AgentRunner.prototype);
  runner.sessions = new Map([['chat', process]]);
  runner.orchestration = runtime;
  return {runner, runtime, process};
}

test('restarting an active managed response records an intentional interruption, not PROCESS_EXITED', async () => {
  const {runner, runtime, process} = fixture();
  const turn = startProcessTurn(process as unknown as WorkerProcess, 'fixture', undefined);
  runtime.active.set('session', {turn, stopping:false, decision:{id:'decision'}});
  await new Promise(resolve => setImmediate(resolve));
  await runner.restartProcess('chat', 'session');
  await expect(turn.result).resolves.toMatchObject({interrupted:true});
  expect(runtime.decisions.interrupt).toHaveBeenCalledTimes(1);
  expect(runtime.active.get('session').stopReason).toBe('user');
  expect(runner.sessions.has('chat')).toBe(false);
});

test('restart marks a preparing turn stopped even before its process exists', async () => {
  const {runner, runtime, process} = fixture(); runner.sessions.clear();
  runtime.active.set('session', {stopping:false});
  await runner.restartProcess('chat', 'session');
  expect(runtime.active.get('session').stopping).toBe(true);
  expect(process.stop).not.toHaveBeenCalled();
});

test('stale confirmation cannot interrupt another session', async () => {
  const {runner, runtime, process} = fixture();
  runtime.active.set('session', {stopping:false});
  await expect(runner.restartProcess('chat', 'old-session')).rejects.toThrow('active session changed');
  expect(process.stop).not.toHaveBeenCalled();
  expect(runtime.active.get('session').stopping).toBe(false);
});

test('restart preserves a replacement process registered while stopping the old one', async () => {
  const {runner, process} = fixture(); const replacement = {};
  process.stop.mockImplementation(async () => { runner.sessions.set('chat', replacement); });
  await runner.restartProcess('chat', 'session');
  expect(runner.sessions.get('chat')).toBe(replacement);
});
