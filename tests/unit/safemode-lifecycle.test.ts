import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SafemodeStore, alive } from '../../src/safemode/store';
import { resolveSafemodeSettings } from '../../src/safemode/config';
import { getRequest, recoverSession, runSession, stopSession } from '../../src/safemode/runner';
import { buildNativeInvocation } from '../../src/safemode/native';

jest.mock('../../src/safemode/context', () => ({prepareContext: jest.fn(async () => ({prompt: 'Test context'}))}));
jest.mock('../../src/safemode/native', () => ({buildNativeInvocation: jest.fn(), discoverCodexSession: jest.fn(), extractNativeSessionId: jest.fn()}));

describe('safemode ownership and native lifecycle', () => {
  let root: string;
  let store: SafemodeStore;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'safemode-test-')); store = new SafemodeStore(root); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); jest.clearAllMocks(); });
  test('exclusive ownership refuses a second launch, including recovery of a live owner', () => {
    const session = store.create('test', 'claude', 'inherit');
    const owner = store.acquire(session.id, 'interactive');
    expect(() => store.acquire(session.id, 'headless')).toThrow('Busy');
    expect(() => recoverSession(store, session.id)).toThrow('still alive');
    expect(store.owner(session.id)).toEqual(owner);
    store.release(session.id, {...owner, token: 'other'});
    expect(store.owner(session.id)).toEqual(owner);
    store.release(session.id, owner);
    expect(store.owner(session.id)).toBeUndefined();
  });
  test('live orphan child prevents recovery after supervisor exit', () => {
    const session = store.create('test', 'claude', 'inherit');
    const owner = store.acquire(session.id, 'interactive');
    store.updateOwner(session.id, { ...owner, pid: 2147483647, childPid: process.pid });
    expect(() => recoverSession(store, session.id)).toThrow('still alive');
  });
  test('model precedence and CLI resume identity', () => {
    const file = path.join(root, 'config.json');
    fs.writeFileSync(file, JSON.stringify({safemode: {cli: 'codex', codex: {model: 'configured'}}}));
    expect(resolveSafemodeSettings({config: file})).toEqual({cli: 'codex', model: 'configured'});
    const session = store.create('test', 'codex', 'saved');
    expect(resolveSafemodeSettings({config: file}, session).model).toBe('saved');
    expect(resolveSafemodeSettings({config: file, model: 'explicit'}, session).model).toBe('explicit');
    expect(() => resolveSafemodeSettings({config: file, cli: 'claude'}, session)).toThrow('different CLI');
    expect(resolveSafemodeSettings({config: path.join(root, 'missing')})).toEqual({cli: 'claude', model: 'inherit'});
  });
  test('headless request is idempotent and conflicting request IDs fail', async () => {
    const session = store.create('test', 'claude', 'inherit');
    (buildNativeInvocation as jest.Mock).mockImplementation((o) => ({command: process.execPath, args: ['-e', 'process.exit(0)'], env: process.env, cwd: o.cwd, nativeSessionId: o.nativeSessionId}));
    expect(await runSession(store, session, {mode:'headless', prompt:'inspect', requestId:'request-1'})).toBe(0);
    expect(await runSession(store, session, {mode:'headless', prompt:'inspect', requestId:'request-1'})).toBe(0);
    expect(buildNativeInvocation).toHaveBeenCalledTimes(1);
    await expect(runSession(store, session, {mode:'headless', prompt:'different', requestId:'request-1'})).rejects.toThrow('different input');
    expect(store.owner(session.id)).toBeUndefined();
    expect(getRequest(store,session.id,'request-1')?.status).toBe('completed');
  });
  test('stop acknowledges only after native process exits and ownership releases', async () => {
    const session = store.create('test', 'claude', 'inherit');
    (buildNativeInvocation as jest.Mock).mockImplementation((o) => ({command: process.execPath, args: ['-e', "setInterval(()=>{},1000)"], env: process.env, cwd: o.cwd, nativeSessionId:o.nativeSessionId}));
    const running = runSession(store, session, {mode:'headless', prompt:'inspect', requestId:'request-2'});
    for (let i=0;i<100 && !store.owner(session.id)?.childPid;i++) await new Promise(resolve => setTimeout(resolve,10));
    expect(store.owner(session.id)?.childPid).toBeDefined();
    await stopSession(store, session.id);
    expect(await running).toBe(1);
    expect(store.owner(session.id)).toBeUndefined();
    expect(store.read(session.id).nativeSessionId).toBe(session.id);
  });
  test('post-spawn setup failure terminates child before releasing ownership', async () => {
    const session = store.create('test', 'claude', 'inherit');
    (buildNativeInvocation as jest.Mock).mockImplementation((o) => ({command:process.execPath,args:['-e','setInterval(()=>{},1000)'],env:process.env,cwd:o.cwd}));
    const update = store.updateOwner.bind(store);
    let childPid: number | undefined;
    const spy = jest.spyOn(store, 'updateOwner').mockImplementation((id, owner) => {
      if (owner.childPid) { childPid = owner.childPid; throw new Error('Simulated disk failure'); }
      update(id, owner);
    });
    await expect(runSession(store,session,{mode:'headless',prompt:'inspect'})).rejects.toThrow('disk failure');
    expect(childPid).toBeDefined();
    expect(alive(childPid)).toBe(false);
    expect(store.owner(session.id)).toBeUndefined();
    spy.mockRestore();
  });
  test('spawn error retains failed request and releases lock', async () => {
    const session = store.create('test', 'claude', 'inherit');
    (buildNativeInvocation as jest.Mock).mockImplementation((o) => ({command:path.join(root,'missing-native-cli'), args:[], env:process.env,cwd:o.cwd}));
    await expect(runSession(store,session,{mode:'headless',prompt:'inspect',requestId:'request-3'})).rejects.toThrow();
    expect(store.owner(session.id)).toBeUndefined();
    expect(getRequest(store,session.id,'request-3')?.status).toBe('failed');
  });
});
