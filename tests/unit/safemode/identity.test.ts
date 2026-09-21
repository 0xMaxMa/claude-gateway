import fs from 'fs';
import os from 'os';
import path from 'path';
import { SafemodeStore, atomicJson } from '../../../src/safemode/store';
import { controlPath, recoverSession } from '../../../src/safemode/runner';
import { buildNativeInvocation } from '../../../src/safemode/native';

const old = '11111111-1111-4111-8111-111111111111';
const native = '22222222-2222-4222-8222-222222222222';
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-id-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function legacy(active = false) {
  const dir = path.join(root, old);
  fs.mkdirSync(path.join(dir, 'workspace'), {recursive: true});
  atomicJson(path.join(dir, 'session.json'), {id: old, name: old, cli: 'codex', model: 'inherit', nativeSessionId: native});
  fs.writeFileSync(path.join(dir, 'output.log'), 'keep this');
  if (active) atomicJson(path.join(dir, 'owner.json'), {pid: process.pid, token: 'old-owner', mode: 'interactive'});
  return dir;
}
test('idle legacy metadata migrates to the native ID while preserving workspace and logs', () => {
  const dir = legacy();
  const store = new SafemodeStore(root);
  expect(store.find(native)).toMatchObject({id: native, name: native, nativeSessionId: native});
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')).id).toBe(native);
  expect(store.dir(native)).toBe(dir);
  expect(fs.readFileSync(path.join(store.dir(native), 'output.log'), 'utf8')).toBe('keep this');
});
test('live legacy supervisor is addressable by native ID without rewriting or moving its state', () => {
  const dir = legacy(true);
  const before = fs.readFileSync(path.join(dir, 'session.json'), 'utf8');
  const store = new SafemodeStore(root);
  expect(store.find(native).id).toBe(native);
  expect(store.owner(native)?.token).toBe('old-owner');
  expect(controlPath(store, native)).toBe(path.join(root, old + '.sock'));
  expect(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')).toBe(before);
});
test('fresh Claude uses its public ID at native creation, not resume', () => {
  const store = new SafemodeStore(root), s = store.create(undefined, 'claude', 'inherit');
  const invocation = buildNativeInvocation({cli: 'claude', mode: 'interactive', cwd: store.dir(s.id), nativeSessionId: s.nativeSessionId, resume: s.nativeStarted});
  expect(invocation.nativeSessionId).toBe(s.id);
  expect(invocation.args).toEqual(expect.arrayContaining(['--session-id', s.id]));
  expect(invocation.args).not.toContain('--resume');
});
test('Codex discovery adopts its ID without losing the live owner, socket or workspace', () => {
  const store = new SafemodeStore(root), s = store.create(undefined, 'codex', 'inherit');
  expect(s.nativeSessionId).toBeUndefined();
  const directory = store.dir(s.id), socket = controlPath(store, s.id);
  const owner = store.acquire(s.id, 'interactive');
  s.nativeSessionId = native; store.save(s);
  expect(s.id).toBe(native);
  expect(s.name).toBe(native);
  expect(store.dir(native)).toBe(directory);
  expect(controlPath(store, native)).toBe(socket);
  expect(store.owner(native)).toEqual(owner);
  store.release(native, owner);
  expect(new SafemodeStore(root).find(native).id).toBe(native);
});
test('a recorded native identity cannot be replaced by another conversation', () => {
  const store = new SafemodeStore(root), s = store.create('fixed', 'claude', 'inherit');
  const original = s.id;
  expect(() => store.save({...s, nativeSessionId: native})).toThrow('Cannot change');
  expect(store.read(original).nativeSessionId).toBe(original);
});
test('rename works with a live owner and survives a stale supervisor save', () => {
  const store = new SafemodeStore(root), session = store.create('old', 'claude', 'inherit');
  const owner = store.acquire(session.id, 'interactive');
  const stale = {...session}, workspace = store.dir(session.id), socket = controlPath(store, session.id);
  expect(store.rename(session.id, 'gateway-debug')).toMatchObject({id: session.id, name: 'gateway-debug'});
  stale.lastRequest = {id:'progress', promptHash:'hash', status:'completed'};
  store.save(stale);
  expect(store.find('gateway-debug')).toMatchObject({id: session.id, lastRequest:{id:'progress'}});
  expect(() => store.find('old')).toThrow('not found');
  expect(store.owner(session.id)).toEqual(owner);
  expect(store.dir(session.id)).toBe(workspace);
  expect(controlPath(store, session.id)).toBe(socket);
  expect(new SafemodeStore(root).find('gateway-debug').name).toBe('gateway-debug');
  expect(store.create('old', 'claude', 'inherit').name).toBe('old');
});
test('rename rejects collisions, native IDs of other sessions, and unsafe names', () => {
  const store = new SafemodeStore(root), a = store.create('one', 'claude', 'inherit'), b = store.create('two', 'claude', 'inherit');
  for (const name of ['two', b.id, '../escape', '', 'a'.repeat(65)]) expect(() => store.rename(a.id, name)).toThrow();
  expect(store.find('one').id).toBe(a.id);
  expect(store.rename('one', 'one').id).toBe(a.id);
});
test('creating an alias cannot shadow another native session ID', () => {
  const store = new SafemodeStore(root), first = store.create('existing', 'claude', 'inherit');
  expect(() => store.create(first.id, 'claude', 'inherit')).toThrow('unique');
  expect(store.find(first.id).name).toBe('existing');
});
test('a progress save cannot reclaim an alias renamed concurrently', () => {
  const store = new SafemodeStore(root), session = store.create('initial', 'claude', 'inherit');
  store.rename(session.id, 'first');
  const originalRead = fs.readFileSync;
  const aliasFile = path.join(store.dir(session.id), 'name.json');
  let armed = true;
  const spy = jest.spyOn(fs, 'readFileSync').mockImplementation(((...args: any[]) => {
    const result = (originalRead as any)(...args);
    if (armed && String(args[0]) === aliasFile) {
      armed = false;
      store.rename(session.id, 'second');
      store.create('first', 'claude', 'inherit');
    }
    return result;
  }) as any);
  try {
    session.lastRequest = {id:'progress', promptHash:'hash', status:'completed'};
    expect(() => store.save(session)).not.toThrow();
    expect(store.find('second').lastRequest?.id).toBe('progress');
    expect(store.find('first').id).not.toBe(session.id);
  } finally { spy.mockRestore(); }
});

test('explicit recovery repairs interrupted rename after its owner exits', () => {
  const store = new SafemodeStore(root), s = store.create('original','claude','inherit');
  const dir = store.dir(s.id), lock = path.join(dir,'renaming');
  atomicJson(lock,{pid:process.pid,name:'reserved'});
  expect(()=>recoverSession(store,s.id)).toThrow('Rename owner');
  atomicJson(lock,{pid:2147483647,name:'reserved'});
  fs.writeFileSync(path.join(root,'names','reserved'),path.basename(dir));
  recoverSession(store,s.id);
  expect(fs.existsSync(lock)).toBe(false);
  expect(fs.existsSync(path.join(root,'names','reserved'))).toBe(false);
  expect(store.rename(s.id,'reserved').name).toBe('reserved');
});

test('idle workspace aligns to native ID while old cwd remains a compatibility link', () => {
  const original=legacy(), store=new SafemodeStore(root);
  store.rename(native,'named');
  const owner=store.acquire(native,'interactive');
  store.alignStorage(native,owner);
  expect(store.dir(native)).toBe(path.join(root,native));
  expect(fs.lstatSync(original).isSymbolicLink()).toBe(true);
  expect(fs.realpathSync(original)).toBe(store.dir(native));
  expect(fs.readFileSync(path.join(original,'output.log'),'utf8')).toBe('keep this');
  expect(store.list()).toHaveLength(1);
  expect(store.owner(native)).toEqual(owner);
  store.save(store.read(native));
  expect(store.find('named').id).toBe(native);
  expect(fs.readFileSync(path.join(root,'names','named'),'utf8')).toBe(native);
  expect(fs.readFileSync(path.join(root,'native-bindings','codex-'+native),'utf8')).toBe(native);
  store.release(native,owner);
});
test('alignment refuses active native processes, foreign owners and occupied destinations', () => {
  const original=legacy(),store=new SafemodeStore(root),owner=store.acquire(native,'interactive');
  expect(()=>store.alignStorage(native,{...owner,token:'wrong'})).toThrow('exclusive ownership');
  store.updateOwner(native,{...owner,childPid:process.pid});
  expect(()=>store.alignStorage(native,owner)).toThrow('exited native');
  store.updateOwner(native,owner);
  fs.mkdirSync(path.join(root,native));
  expect(()=>store.alignStorage(native,owner)).toThrow('destination already exists');
  expect(fs.lstatSync(original).isDirectory()).toBe(true);
});
test('alignment failure rolls the directory back without losing ownership or reservations', () => {
  const original=legacy(),store=new SafemodeStore(root),owner=store.acquire(native,'interactive');
  const spy=jest.spyOn(fs,'symlinkSync').mockImplementation(()=>{throw Error('disk failure');});
  try { expect(()=>store.alignStorage(native,owner)).toThrow('disk failure'); } finally { spy.mockRestore(); }
  expect(store.dir(native)).toBe(original);
  expect(store.owner(native)).toEqual(owner);
  expect(fs.existsSync(path.join(original,'renaming'))).toBe(false);
  store.save(store.read(native));
});
