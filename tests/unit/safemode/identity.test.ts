import fs from 'fs';
import os from 'os';
import path from 'path';
import { SafemodeStore, atomicJson } from '../../../src/safemode/store';
import { controlPath } from '../../../src/safemode/runner';
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
