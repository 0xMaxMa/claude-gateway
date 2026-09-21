import { AgentLifecycle } from '../../src/config/agent-lifecycle';

function fixture() {
  let desired: { id: string; name: string } | undefined;
  let release!: () => void;
  const old = { canRemoveFromConfig: jest.fn(() => true), stop: jest.fn(() => new Promise<void>(resolve => { release = resolve; })) };
  let current: typeof old | undefined = old;
  const start = jest.fn(async (_config: { id: string; name: string }) => {
    current = { canRemoveFromConfig: jest.fn(() => true), stop: jest.fn(async () => {}) };
  });
  const remove = jest.fn((_id, runner) => { if (current === runner) current = undefined; });
  const error = jest.fn();
  const lifecycle = new AgentLifecycle({ desired: () => desired, runner: () => current, start, remove, error });
  return { lifecycle, old, start, remove, error, set: (value: typeof desired) => { desired = value; }, release: () => release(), current: () => current };
}

test('re-add during stop starts exactly one fresh runner using the latest config', async () => {
  const f = fixture();
  const removal = f.lifecycle.reconcile('agent');
  await Promise.resolve();
  f.set({ id: 'agent', name: 'latest' });
  const addition = f.lifecycle.reconcile('agent');
  f.lifecycle.reconcile('agent');
  expect(f.start).not.toHaveBeenCalled();
  f.release(); await Promise.all([removal, addition]);
  expect(f.old.stop).toHaveBeenCalledTimes(1);
  expect(f.remove).toHaveBeenCalledTimes(1);
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.start).toHaveBeenCalledWith({ id: 'agent', name: 'latest' });
  expect(f.current()).not.toBe(f.old);
  expect(f.error).not.toHaveBeenCalled();
  await f.lifecycle.close();
});

test('re-add then remove during stop does not resurrect a deleted agent', async () => {
  const f = fixture(), work = f.lifecycle.reconcile('agent'); await Promise.resolve();
  f.set({ id: 'agent', name: 'temporary' }); f.lifecycle.reconcile('agent');
  f.set(undefined); f.lifecycle.reconcile('agent'); f.release(); await work;
  expect(f.current()).toBeUndefined(); expect(f.start).not.toHaveBeenCalled();
  await f.lifecycle.close();
});

test('busy removal waits for idle and can be withdrawn without stopping the runner', async () => {
  const f = fixture(); f.old.canRemoveFromConfig.mockReturnValue(false);
  await f.lifecycle.reconcile('agent'); expect(f.old.stop).not.toHaveBeenCalled();
  f.set({ id: 'agent', name: 'retained' }); await f.lifecycle.reconcile('agent');
  f.old.canRemoveFromConfig.mockReturnValue(true); f.lifecycle.retry(); await Promise.resolve();
  expect(f.old.stop).not.toHaveBeenCalled(); expect(f.current()).toBe(f.old);
  await f.lifecycle.close();
});

test('shutdown never starts a replacement after a pending stop', async () => {
  const f = fixture(), removal = f.lifecycle.reconcile('agent'); await Promise.resolve();
  f.set({ id: 'agent', name: 'latest' }); f.lifecycle.reconcile('agent');
  const closing = f.lifecycle.close(); f.release(); await Promise.all([removal, closing]);
  expect(f.start).not.toHaveBeenCalled();
});
