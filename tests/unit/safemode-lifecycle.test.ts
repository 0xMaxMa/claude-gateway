import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { SafemodeStore, alive } from '../../src/safemode/store';
import { resolveSafemodeSettings } from '../../src/safemode/config';
import { controlPath, getRequest, recoverSession, runSession, stopSession } from '../../src/safemode/runner';
import { buildNativeInvocation } from '../../src/safemode/native';
import { assertNoExternalNativeOwner, ExternalOwnerFound } from '../../src/safemode/external-owners';

jest.mock('../../src/safemode/external-owners', () => ({...jest.requireActual('../../src/safemode/external-owners'), assertNoExternalNativeOwner: jest.fn()}));

jest.mock('../../src/session/codex-auth', () => ({codexSafemodeEnvironment: jest.fn(async (_bin, env) => env)}));

jest.mock('../../src/safemode/context', () => ({prepareContext: jest.fn(async () => ({prompt: 'Test context'}))}));
jest.mock('../../src/safemode/native', () => ({buildNativeInvocation: jest.fn(), discoverCodexSession: jest.fn(), extractNativeSessionId: jest.fn()}));

describe('safemode ownership and native lifecycle', () => {
  let root: string;
  let store: SafemodeStore;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'safemode-test-')); store = new SafemodeStore(root); (assertNoExternalNativeOwner as jest.Mock).mockReset(); });
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
  test.each(['claude', 'codex'] as const)('%s interactive resume can omit bootstrap while refreshing diagnostics', async cli => {
    const session = store.create('quiet', cli, 'inherit', undefined, '11111111-2222-4333-8444-555555555555');
    (buildNativeInvocation as jest.Mock).mockImplementation(o => ({command:process.execPath,args:['-e','process.exit(0)'],cwd:o.cwd,env:process.env,nativeSessionId:o.nativeSessionId}));
    for (const prompt of [undefined, 'Inspect this new symptom']) {
      expect(await runSession(store,session,{mode:'interactive',noBootstrap:true,prompt})).toBe(0);
      expect(buildNativeInvocation).toHaveBeenLastCalledWith(expect.objectContaining({resume:true,context:undefined,prompt}));
      expect(require('../../src/safemode/context').prepareContext).toHaveBeenLastCalledWith(path.join(store.dir(session.id),'workspace'),undefined,prompt);
    }
    expect(await runSession(store,session,{mode:'interactive'})).toBe(0);
    expect(buildNativeInvocation).toHaveBeenLastCalledWith(expect.objectContaining({context:'Test context'}));
  });
  test('no-bootstrap requires a started native session and supports headless continuation', async () => {
    const session=store.create('fresh','claude','inherit');
    await expect(runSession(store,session,{mode:'interactive',noBootstrap:true})).rejects.toThrow('existing native conversation');
    session.nativeStarted=true;
    store.save(session);
    await expect(runSession(store,session,{mode:'headless',noBootstrap:true,prompt:'inspect'})).resolves.toBe(0);
    expect(buildNativeInvocation).toHaveBeenLastCalledWith(expect.objectContaining({context:undefined,mode:'headless'}));
    expect(store.owner(session.id)).toBeUndefined();
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
  test('takeover refuses a replacement owner on both client and receiver', async () => {
    const session = store.create('test', 'claude', 'inherit');
    const previous = store.acquire(session.id, 'interactive');
    store.release(session.id, previous);
    (buildNativeInvocation as jest.Mock).mockImplementation(o => ({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], env: process.env, cwd: o.cwd }));
    const running = runSession(store, session, { mode: 'headless' });
    try {
      for (let i=0;i<100 && !store.owner(session.id)?.childPid;i++) await new Promise(resolve=>setTimeout(resolve,10));
      const replacement = store.owner(session.id)!;
      await expect((stopSession as any)(store, session.id, previous)).rejects.toThrow('owner changed');
      const response = await new Promise<string>((resolve,reject) => {
        const socket=net.createConnection(controlPath(store,session.id));
        let data='';
        socket.on('connect',()=>socket.end(JSON.stringify({action:'stop',ownerToken:previous.token})+'\n'));
        socket.on('data',chunk=>data+=chunk.toString());
        socket.on('close',()=>resolve(data.trim()));socket.on('error',reject);
      });
      expect(response).toBe('owner-changed');
      expect(store.owner(session.id)?.token).toBe(replacement.token);
      expect(alive(replacement.childPid)).toBe(true);
    } finally { await stopSession(store,session.id); await running; }
  });
  test('bounded output keeps the final diagnosis after verbose output exceeds the cap', async () => {
    const session=store.create('test','claude','inherit');
    (buildNativeInvocation as jest.Mock).mockImplementation(o=>({command:process.execPath,args:['-e', "process.stdout.write('x'.repeat(6*1024*1024));process.stdout.write('\\nFINAL_DIAGNOSIS_MARKER\\n')"],cwd:o.cwd,env:process.env}));
    expect(await runSession(store,session,{mode:'headless',requestId:'large',prompt:'inspect'})).toBe(0);
    const log=fs.readFileSync(path.join(store.dir(session.id),'output.log'));
    expect(log.length).toBeLessThanOrEqual(5*1024*1024);
    expect(log.toString()).toContain('FINAL_DIAGNOSIS_MARKER');
    expect(getRequest(store,session.id,'large')?.status).toBe('completed');
  });
  test('an external native owner blocks launch despite an empty safemode lock', async () => {
    const session=store.create('test','claude','inherit');
    (assertNoExternalNativeOwner as jest.Mock).mockImplementation(()=>{throw new Error('Busy: external native owner');});
    await expect(runSession(store,session,{mode:'headless'})).rejects.toThrow('external native owner');
    expect(buildNativeInvocation).not.toHaveBeenCalled();
    expect(store.owner(session.id)).toBeUndefined();
  });
  test.each(['claude','codex'] as const)('%s stops only the managed process when a later external owner is detected', async cli => {
    const session=store.create('test',cli,'inherit',undefined,'11111111-2222-4333-8444-555555555555');
    (buildNativeInvocation as jest.Mock).mockImplementation(o=>({command:process.execPath,args:['-e','setInterval(()=>{},1000)'],env:process.env,cwd:o.cwd}));
    (assertNoExternalNativeOwner as jest.Mock).mockImplementation(options=>{
      if(options.ignorePids?.length)throw new ExternalOwnerFound(9001);
    });
    expect(await runSession(store,session,{mode:'headless',prompt:'inspect',requestId:'collision'})).toBe(1);
    expect(getRequest(store,session.id,'collision')).toMatchObject({status:'failed',error:expect.stringContaining('external native CLI process 9001')});
    expect(store.owner(session.id)).toBeUndefined();
    expect(fs.readFileSync(path.join(store.dir(session.id),'output.log'),'utf8')).toContain('external native CLI process 9001');
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
  test.each(['claude','codex'] as const)('%s stays alive when monitoring metadata becomes inaccessible', async cli => {
    const session=store.create('monitor',cli,'inherit',undefined,'11111111-2222-4333-8444-555555555555');
    (buildNativeInvocation as jest.Mock).mockImplementation(o=>({command:process.execPath,args:['-e','setTimeout(()=>process.exit(0),2400)'],env:process.env,cwd:o.cwd}));
    let checks=0;
    (assertNoExternalNativeOwner as jest.Mock).mockImplementation(options=>{
      if(options.ignorePids?.length){ checks++;throw new Error('Cannot verify external native session ownership: process metadata is inaccessible.'); }
    });
    const stderr=jest.spyOn(process.stderr,'write').mockImplementation(()=>true);
    try {
      expect(await runSession(store,session,{mode:'headless',prompt:'inspect',requestId:'metadata'})).toBe(0);
      expect(checks).toBeGreaterThanOrEqual(2);
      expect(getRequest(store,session.id,'metadata')).toMatchObject({status:'completed',exitCode:0});
      expect(store.owner(session.id)).toBeUndefined();
      const log=fs.readFileSync(path.join(store.dir(session.id),'output.log'),'utf8');
      expect(log.match(/keeping this session running/g)).toHaveLength(1);
      expect(log).not.toContain('Stopping safemode');
    } finally { stderr.mockRestore(); }
  });
  test('unavailable preflight still refuses a new launch', async()=>{
    const session=store.create('blocked','claude','inherit');
    (buildNativeInvocation as jest.Mock).mockClear();
    (assertNoExternalNativeOwner as jest.Mock).mockImplementation(()=>{throw new Error('metadata inaccessible');});
    await expect(runSession(store,session,{mode:'headless',prompt:'inspect'})).rejects.toThrow('metadata inaccessible');
    expect(buildNativeInvocation).not.toHaveBeenCalled();
    expect(store.owner(session.id)).toBeUndefined();
  });

});
