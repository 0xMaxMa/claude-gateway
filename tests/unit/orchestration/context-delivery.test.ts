import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ContextDelivery, ContextDeliveryScope } from '../../../src/orchestration/context-delivery';
import { OrchestrationStore } from '../../../src/orchestration/store';

const ingress = { agentId: 'a', agentSessionId: 's', source: 'api' as const, accountId: 'a', chatId: 'c', threadKey: '', principalId: 'u' };
const item = { id: 'task-1', state: 'running', text: 'private full payload '.repeat(500) };
const key = (value: { id: string }) => value.id;
let dir: string, store: OrchestrationStore, delivery: ContextDelivery, scope: ContextDeliveryScope;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'delivery-'));
  store = new OrchestrationStore(join(dir, 'store.db'), 'a');
  const receipt = store.acceptInput({ scope: ingress, text: 'original user message' });
  scope = { ...receipt, principalId: 'u', cliSessionId: 'cli-1', resume: true };
  delivery = new ContextDelivery(store);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

test('legacy bootstrap preserves complete data then persists canonical hashes across restart', () => {
  const first = delivery.begin(scope);
  expect(first.fresh).toBe(true);
  expect(first.select('tasks', [item], key)).toEqual([item]);
  first.mark('images', 'image-1', { received: true });
  expect(first.commit()).toBe(true);
  expect(JSON.stringify(store.all('SELECT * FROM context_delivery'))).not.toContain('private full payload');
  store.close();
  store = new OrchestrationStore(join(dir, 'store.db'), 'a');
  delivery = new ContextDelivery(store);
  const resumed = delivery.begin(scope);
  expect(resumed.fresh).toBe(false);
  expect(resumed.select('tasks', [{ text: item.text, state: item.state, id: item.id }], key)).toEqual([]);
  expect(resumed.includes('images', 'image-1')).toBe(true);
  expect(resumed.includes('other-bucket', 'image-1')).toBe(false);
  expect(store.get('SELECT text FROM conversation_inputs WHERE conversation_id=?', scope.conversationId)?.text).toBe('original user message');
});

test('only new and changed values are returned, preserving all original content', () => {
  const initial = delivery.begin(scope);
  initial.select('tasks', [item], key); initial.commit();
  const next = delivery.begin(scope);
  const changed = { ...item, state: 'completed' }, added = { ...item, id: 'task-2' };
  expect(next.select('tasks', [item, added, changed], key)).toEqual([added, changed]);
  expect(next.commit()).toBe(true);
  expect(delivery.begin(scope).select('tasks', [changed, added], key)).toEqual([]);
});

test('discarding an interrupted or failed turn leaves checkpoint untouched', () => {
  const initial = delivery.begin(scope);
  initial.select('tasks', [item], key); initial.commit();
  const before = store.get('SELECT * FROM context_delivery');
  const failed = delivery.begin(scope);
  failed.select('tasks', [{ ...item, state: 'failed' }], key);
  failed.mark('images', 'undelivered', 'payload');
  expect(store.get('SELECT * FROM context_delivery')).toEqual(before);
  const next = delivery.begin(scope);
  expect(next.select('tasks', [item], key)).toEqual([]);
  expect(next.includes('images', 'undelivered')).toBe(false);
});

test.each([{ resume: false }, { cliSessionId: 'cli-2' }])('new contexts replay everything and failed resets retain the old checkpoint: %j', reset => {
  const initial = delivery.begin(scope);
  initial.select('tasks', [item], key); initial.commit();
  const next = delivery.begin({ ...scope, ...reset });
  expect(next.fresh).toBe(true);
  expect(next.select('tasks', [item], key)).toEqual([item]);
  expect(delivery.begin(scope).select('tasks', [item], key)).toEqual([]);
  expect(next.commit()).toBe(true);
  expect(delivery.begin({ ...scope, ...reset, resume: true }).select('tasks', [item], key)).toEqual([]);
});

test('compact invalidation clears scoped state and fences pre-compact plans', () => {
  const first = delivery.begin(scope), staleBootstrap = delivery.begin(scope);
  first.select('tasks', [item], key);
  first.invalidate();
  expect(first.commit()).toBe(false);
  expect(staleBootstrap.commit()).toBe(false);
  const next = delivery.begin(scope);
  expect(next.fresh).toBe(true);
  expect(next.select('tasks', [item], key)).toEqual([item]);
  expect(next.commit()).toBe(true);
  const stale = delivery.begin(scope);
  next.invalidate();
  expect(stale.commit()).toBe(false);
  expect(delivery.begin(scope).select('tasks', [item], key)).toEqual([item]);
});

test('manual compact fences absent and committed checkpoints', () => {
  const absent = delivery.begin(scope);
  absent.select('tasks', [item], key);
  delivery.invalidateConversation(scope.conversationId);
  expect(absent.commit()).toBe(false);
  const first = delivery.begin(scope);
  first.select('tasks', [item], key); first.commit();
  const stale = delivery.begin(scope);
  delivery.invalidateConversation(scope.conversationId);
  expect(stale.commit()).toBe(false);
  expect(delivery.begin(scope).select('tasks', [item], key)).toEqual([item]);
});

test('membership and binding are checked and authorized principals/bindings do not share receipts', () => {
  const initial = delivery.begin(scope);
  initial.select('tasks', [item], key); initial.commit();
  expect(() => delivery.begin({ ...scope, principalId: 'outsider' })).toThrow('ACCESS_DENIED');
  const other = store.acceptInput({ scope: { ...ingress, agentSessionId: 'other', chatId: 'other' }, text: 'other' });
  expect(() => delivery.begin({ ...scope, bindingId: other.bindingId })).toThrow('ACCESS_DENIED');
  store.run("INSERT INTO conversation_members VALUES(?,?,'member')", scope.conversationId, 'member');
  expect(delivery.begin({ ...scope, principalId: 'member' }).select('tasks', [item], key)).toEqual([item]);
  store.run("INSERT INTO conversation_bindings VALUES(?,?,'api','a','other','','next_user_turn','{}')", 'binding-2', scope.conversationId);
  expect(delivery.begin({ ...scope, bindingId: 'binding-2' }).select('tasks', [item], key)).toEqual([item]);
});

test('atomic CAS rejects older plans across connections, including concurrent bootstraps', () => {
  const secondStore = new OrchestrationStore(join(dir, 'store.db'), 'a');
  try {
    const second = new ContextDelivery(secondStore);
    const oldBootstrap = delivery.begin(scope), newBootstrap = second.begin(scope);
    newBootstrap.select('tasks', [item], key);
    expect(newBootstrap.commit()).toBe(true);
    expect(oldBootstrap.commit()).toBe(false);
    const older = delivery.begin(scope), newer = second.begin(scope);
    older.mark('images', 'stale-image', true);
    newer.mark('images', 'new-image', true);
    expect(newer.commit()).toBe(true);
    expect(older.commit()).toBe(false);
    expect(newer.commit()).toBe(false);
    const result = delivery.begin(scope);
    expect(result.includes('images', 'stale-image')).toBe(false);
    expect(result.includes('images', 'new-image')).toBe(true);
    expect(result.select('tasks', [item], key)).toEqual([]);
  } finally { secondStore.close(); }
});


test('image aliases commit only on delivery and legacy fingerprints cannot imply a mapping', () => {
  const legacy = delivery.begin(scope);
  legacy.mark('images', 'old-ref', true);
  legacy.mark('image-content', 'digest', true);
  legacy.commit();
  const failed = delivery.begin(scope);
  expect(failed.imageReference('old-ref')).toBeUndefined();
  expect(failed.rememberImage('first', 'digest')).toBeUndefined();
  expect(failed.rememberImage('alias', 'digest')).toBe('first');
  expect(delivery.begin(scope).imageReference('alias')).toBeUndefined();
  expect(failed.commit()).toBe(true);
  const resumed = delivery.begin(scope);
  expect(resumed.imageReference('alias')).toBe('first');
  expect(resumed.rememberImage('another', 'digest')).toBe('first');
  delivery.invalidateConversation(scope.conversationId);
  expect(resumed.commit()).toBe(false);
  expect(delivery.begin(scope).imageReference('alias')).toBeUndefined();
});

test('compaction invalidates every conversation sharing the CLI session but not another session', () => {
  const second = store.acceptInput({scope:{...ingress,chatId:'second'},text:'second'});
  const unrelated = store.acceptInput({scope:{...ingress,agentSessionId:'separate',chatId:'third'},text:'third'});
  const secondScope = {...scope,...second};
  const unrelatedScope = {...scope,...unrelated,cliSessionId:'other-cli'};
  for(const current of [scope,secondScope,unrelatedScope]) {
    const plan=delivery.begin(current);plan.rememberImage('image','digest');plan.select('tasks',[item],key);plan.commit();
  }
  const pending=delivery.begin(secondScope);
  delivery.invalidateConversation(scope.conversationId);
  expect(pending.commit()).toBe(false);
  expect(delivery.begin(secondScope).imageReference('image')).toBeUndefined();
  expect(delivery.begin(secondScope).select('tasks',[item],key)).toEqual([item]);
  expect(delivery.begin(unrelatedScope).imageReference('image')).toBe('image');
});
