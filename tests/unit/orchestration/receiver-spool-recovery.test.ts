import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ReceiverSpool } from '../../../mcp/tools/receiver-spool';
const input = (chat: string, content: string, extra: Record<string, string> = {}) => ({ content, meta: { source: 'telegram', account_id: 'bot', chat_id: chat, ...extra } });
const persist = (root: string, value: unknown, age = 0) => {
  const body = JSON.stringify(value), file = createHash('sha256').update(body).digest('hex') + '.json';
  writeFileSync(join(root, file), body);
  utimesSync(join(root, file), new Date(Date.now() - age), new Date(Date.now() - age));
  return file;
};
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
let root: string;
let spool: ReceiverSpool;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'spool-recovery-')); });
afterEach(() => { spool?.close(); jest.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

test('a rejected conversation retains order but does not block other chats, threads, or accounts', async () => {
  persist(root, input('a', 'first'), 2000);
  persist(root, input('a', 'second'), 1000);
  persist(root, input('b', 'other'));
  persist(root, input('a', 'thread', { message_thread_id: 'thread' }));
  persist(root, input('a', 'account', { account_id: 'other' }));
  const request = jest.fn(async (_: any, init?: RequestInit) => new Response('', { status: JSON.parse(init!.body as string).content === 'first' ? 503 : 200 }));
  spool = new ReceiverSpool(root, 'http://callback', request);
  await tick();
  expect(request.mock.calls.map(c => JSON.parse(c[1]!.body as string).content)).toEqual(expect.arrayContaining(['first', 'other', 'thread', 'account']));
  expect(request).toHaveBeenCalledTimes(4);
  await spool.flush();
  expect(request).toHaveBeenCalledTimes(4);
  expect(readdirSync(root).filter(f => f.endsWith('.json'))).toHaveLength(2);
});

test('network failures back off durably across restart and honor Retry-After', async () => {
  let now = Date.now(); jest.spyOn(Date, 'now').mockImplementation(() => now);
  persist(root, input('a', 'retry'));
  const request = jest.fn<Promise<Response>, [any, RequestInit?]>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '30' } }));
  spool = new ReceiverSpool(root, 'http://callback', request); await tick();
  await spool.flush(); expect(request).toHaveBeenCalledTimes(1);
  spool.close(); spool = new ReceiverSpool(root, 'http://callback', request); await tick();
  expect(request).toHaveBeenCalledTimes(1);
  now += 1000; await spool.flush(); expect(request).toHaveBeenCalledTimes(2);
  now += 29999; await spool.flush(); expect(request).toHaveBeenCalledTimes(2);
  now++; await spool.flush(); expect(request).toHaveBeenCalledTimes(3);
  const state = JSON.parse(readFileSync(join(root, readdirSync(root).find(f => f.endsWith('.retry'))!), 'utf8'));
  expect(state.attempts).toBe(3);
  expect(readdirSync(root).filter(f => f.endsWith('.json'))).toHaveLength(1);
});

test('startup quarantines an entire stale conversation snapshot with stable batch identity, but not fresh enqueue', async () => {
  let now = Date.now(); jest.spyOn(Date, 'now').mockImplementation(() => now);
  persist(root, input('a', 'old'), 360000);
  persist(root, input('a', 'tail'), 1000);
  persist(root, input('b', 'recent'), 500);
  let ok = false;
  const request = jest.fn(async (_: any, init?: RequestInit) => new Response('', { status: ok ? 200 : 503 }));
  spool = new ReceiverSpool(root, 'http://callback', request); await tick();
  const first = request.mock.calls.map(c => JSON.parse(c[1]!.body as string));
  const batch = first.find(v => v.content === 'old').meta.ingress_recovery_batch;
  expect(batch).toMatch(/^[a-f0-9-]{36}$/);
  expect(first.find(v => v.content === 'recent').meta.ingress_recovery_batch).toBeUndefined();
  spool.close(); spool = new ReceiverSpool(root, 'http://callback', request); await tick();
  spool.enqueue(input('a', 'fresh')); await tick();
  ok = true; now += 1000;
  await spool.flush(); await spool.flush(); await spool.flush();
  const bodies = request.mock.calls.map(c => JSON.parse(c[1]!.body as string));
  expect(bodies.filter(v => ['old', 'tail'].includes(v.content)).every(v => v.meta.ingress_recovery_batch === batch)).toBe(true);
  expect(bodies.find(v => v.content === 'fresh').meta.ingress_recovery_batch).toBeUndefined();
  expect(readdirSync(root)).toEqual([]);
});

test('more than 100 failing heads cannot starve another conversation', async () => {
  for (let i = 0; i < 110; i++) persist(root, input(String(i), 'fail'), 2000 + i);
  persist(root, input('healthy', 'success'));
  const request = jest.fn(async (_: any, init?: RequestInit) => new Response('', { status: JSON.parse(init!.body as string).content === 'success' ? 200 : 503 }));
  spool = new ReceiverSpool(root, 'http://callback', request); await tick();
  await spool.flush();
  expect(request.mock.calls.some(c => JSON.parse(c[1]!.body as string).content === 'success')).toBe(true);
});

test('equal-time fresh messages retain enqueue order and late album members use distinct admission identities', async () => {
  jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60000);
  let release: (() => void) | undefined;
  const bodies: any[] = [];
  const request = jest.fn(async (_: any, init?: RequestInit) => {
    bodies.push(JSON.parse(init!.body as string));
    if (bodies.length === 1) await new Promise<void>(resolve => { release = resolve; });
    return new Response('');
  });
  spool = new ReceiverSpool(root, 'http://callback', request, 0);
  const album = (id: string) => input('a', 'photo', { media_group_id: 'album', message_id: id, user_id: 'u' });
  spool.enqueue(album('1')); spool.enqueue(album('2')); spool.enqueue(input('a', 'later'));
  release!(); await tick(); await spool.flush(); await spool.flush();
  expect(bodies.map(v => v.content)).toEqual(['[Media album attached]', '[Media album attached]', 'later']);
  expect(JSON.parse(bodies[0].meta.message_ids_json)).toEqual(['1']);
  expect(JSON.parse(bodies[1].meta.message_ids_json)).toEqual(['2']);
  expect(bodies[1].meta.message_id).not.toBe(bodies[0].meta.message_id);
});

test('exponential retry caps at five minutes and server pause accepts HTTP dates with a one-day bound', async () => {
  let now = Math.floor(Date.now() / 1000) * 1000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  const file = persist(root, input('a', 'retry'));
  let retryAfter = '';
  const request = jest.fn(async () => new Response('', { status: 503, headers: retryAfter ? { 'Retry-After': retryAfter } : {} }));
  const state = () => JSON.parse(readFileSync(join(root, `${file}.retry`), 'utf8'));
  spool = new ReceiverSpool(root, 'http://callback', request); await tick();
  for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000]) {
    expect(state().nextAttemptAt - now).toBe(delay);
    now += delay; await spool.flush();
  }
  now = state().nextAttemptAt;
  retryAfter = new Date(now + 600000).toUTCString();
  await spool.flush(); expect(state().nextAttemptAt - now).toBe(600000);
  now = state().nextAttemptAt; retryAfter = '9999999999999';
  await spool.flush(); expect(state().nextAttemptAt - now).toBe(86400000);
  now = state().nextAttemptAt; retryAfter = 'invalid';
  await spool.flush(); expect(state().nextAttemptAt - now).toBe(300000);
});

test('an album quiet window also holds its conversation tail while other chats progress', async () => {
  const request = jest.fn(async () => new Response(''));
  spool = new ReceiverSpool(root, 'http://callback', request);
  spool.enqueue(input('a', 'photo', { media_group_id: 'album', message_id: '1', user_id: 'u' }));
  spool.enqueue(input('a', 'follow-up'));
  spool.enqueue(input('b', 'other-chat'));
  await tick(); await spool.flush();
  expect(request).toHaveBeenCalledTimes(1);
  expect(readdirSync(root).filter(f => f.endsWith('.json'))).toHaveLength(2);
});

test('corrupt legacy payload is retained without crashing startup or blocking unrelated inputs; diagnostic is bounded and safe', async () => {
  const broken = 'a'.repeat(64) + '.json';
  const contents = '{not-json private-token';
  writeFileSync(join(root, broken), contents);
  persist(root, input('healthy', 'safe'));
  const diagnostic = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
  const request = jest.fn(async () => new Response(''));
  expect(() => { spool = new ReceiverSpool(root, 'http://callback', request); }).not.toThrow();
  await tick(); await spool.flush(); await spool.flush();
  expect(request).toHaveBeenCalledTimes(1);
  expect(readFileSync(join(root, broken), 'utf8')).toBe(contents);
  expect(diagnostic).toHaveBeenCalledTimes(1);
  expect(String(diagnostic.mock.calls[0][0])).not.toContain('private-token');
});

test.each([
  { queuedAt: null, attempts: 0, nextAttemptAt: 0 },
  { queuedAt: 1, attempts: -1, nextAttemptAt: 0 },
  { queuedAt: 1, attempts: 0.5, nextAttemptAt: 0 },
  { queuedAt: 1, attempts: 0, nextAttemptAt: 1e300 },
  { queuedAt: 1, attempts: 0, nextAttemptAt: 0, recoveryBatch: 123 },
])('invalid retry state is retained and holds only its own conversation: %j', async state => {
  const broken = persist(root, input('a', 'head'), 2000);
  writeFileSync(join(root, `${broken}.retry`), JSON.stringify(state));
  persist(root, input('a', 'tail'), 1000);
  persist(root, input('b', 'healthy'));
  jest.spyOn(process.stderr, 'write').mockReturnValue(true);
  const request = jest.fn(async (_: any, init?: RequestInit) => new Response(''));
  spool = new ReceiverSpool(root, 'http://callback', request); await tick(); await spool.flush();
  expect(request).toHaveBeenCalledTimes(1);
  expect(JSON.parse(request.mock.calls[0][1]!.body as string).content).toBe('healthy');
  expect(JSON.parse(readFileSync(join(root, `${broken}.retry`), 'utf8'))).toEqual(state);
  expect(readdirSync(root).filter(file => file.endsWith('.json'))).toHaveLength(2);
});

test('Slack threads in one chat progress independently', async () => {
  persist(root, input('a', 'blocked', { source: 'slack', thread_ts: '1' }), 1000);
  persist(root, input('a', 'healthy', { source: 'slack', thread_ts: '2' }));
  const request = jest.fn(async (_: any, init?: RequestInit) => new Response('', { status: JSON.parse(init!.body as string).content === 'blocked' ? 503 : 200 }));
  spool = new ReceiverSpool(root, 'http://callback', request); await tick();
  expect(request).toHaveBeenCalledTimes(2);
  expect(readdirSync(root).filter(file => file.endsWith('.json'))).toHaveLength(1);
});


test('attempted album identity is frozen through lost ACK, late arrivals, restart, and duplicate platform delivery', async () => {
  let now = Date.now() + 60000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  const admitted = new Map<string, string>();
  const executions: string[][] = [];
  let loseAck = true;
  let release: (() => void) | undefined;
  const request = jest.fn(async (_: any, init?: RequestInit) => {
    const payload = init!.body as string;
    const body = JSON.parse(payload);
    const key = body.meta.message_id;
    if (admitted.has(key)) return new Response('', { status: admitted.get(key) === payload ? 200 : 409 });
    admitted.set(key, payload); executions.push(JSON.parse(body.meta.message_ids_json));
    if (loseAck) {
      loseAck = false;
      await new Promise<void>(resolve => { release = resolve; });
      throw new Error('ACK lost after commit');
    }
    return new Response('');
  });
  const album = (id: string) => input('a', 'photo', { media_group_id: 'album', message_id: id, user_id: 'u' });
  spool = new ReceiverSpool(root, 'http://callback', request, 0);
  spool.enqueue(album('1'));
  spool.enqueue(album('2')); spool.enqueue(album('1'));
  release!(); await tick();
  spool.close(); spool = new ReceiverSpool(root, 'http://callback', request, 0); await tick();
  now += 1000; await spool.flush(); await spool.flush();
  expect(executions).toEqual([['1'], ['2']]);
  expect(readdirSync(root).filter(file => file.endsWith('.json'))).toHaveLength(0);
  spool.close(); spool = new ReceiverSpool(root, 'http://callback', request, 0); await tick();
  spool.enqueue(album('1')); spool.enqueue(album('2')); spool.enqueue(album('3')); await tick(); await spool.flush();
  expect(executions).toEqual([['1'], ['2'], ['3']]);
  expect(readdirSync(root).filter(file => file.endsWith('.json'))).toHaveLength(0);
});

test('acknowledged album receipts expire and remain bounded while pending retry state never expires', async () => {
  const now = Date.now();
  jest.spyOn(Date, 'now').mockReturnValue(now);
  for (let i = 0; i < 1002; i++) {
    const file = createHash('sha256').update(String(i)).digest('hex') + '.json.retry';
    writeFileSync(join(root, file), JSON.stringify({ queuedAt: now, attempts: 0, nextAttemptAt: 0, sealedMessageIds: [String(i)] }));
  }
  const expired = 'e'.repeat(64) + '.json.retry';
  writeFileSync(join(root, expired), JSON.stringify({ queuedAt: now - 90000000, attempts: 0, nextAttemptAt: 0, sealedMessageIds: ['expired'] }));
  utimesSync(join(root, expired), new Date(now - 90000000), new Date(now - 90000000));
  const pending = persist(root, input('a', 'pending'), 90000000);
  writeFileSync(join(root, `${pending}.retry`), JSON.stringify({ queuedAt: now - 90000000, attempts: 2, nextAttemptAt: now + 60000, sealedMessageIds: ['pending'] }));
  const request = jest.fn(async () => new Response(''));
  spool = new ReceiverSpool(root, 'http://callback', request); await tick();
  expect(request).not.toHaveBeenCalled();
  expect(readdirSync(root).filter(file => file.endsWith('.retry'))).toHaveLength(1001);
  expect(readdirSync(root)).not.toContain(expired);
  expect(JSON.parse(readFileSync(join(root, `${pending}.retry`), 'utf8')).attempts).toBe(2);
});

test('an album expanded while a different callback is pending is refreshed before sealing its admission identity', async () => {
  const now = Date.now() + 60000;
  jest.spyOn(Date, 'now').mockReturnValue(now);
  persist(root, input('a', 'hold callback'), 2000);
  const album = (id: string) => input('b', 'photo', { media_group_id: 'album', message_id: id, user_id: 'u' });
  // Enqueue before starting delivery so the first flush snapshots both chats.
  const seed = new ReceiverSpool(root, 'http://callback', async () => new Response('', { status: 503 }), 120000);
  seed.enqueue(album('1')); await tick(); seed.close();
  const first = readdirSync(root).filter(file => file.endsWith('.json')).find(file => JSON.parse(readFileSync(join(root, file), 'utf8')).content === 'hold callback')!;
  const firstState = JSON.parse(readFileSync(join(root, `${first}.retry`), 'utf8'));
  writeFileSync(join(root, `${first}.retry`), JSON.stringify({ ...firstState, nextAttemptAt: 0 }));
  let release: (() => void) | undefined;
  const admitted = new Map<string, string>();
  const albums: any[] = [];
  const request = jest.fn(async (_: any, init?: RequestInit) => {
    const payload = init!.body as string, body = JSON.parse(payload);
    if (body.meta.chat_id === 'a') await new Promise<void>(resolve => { release = resolve; });
    else {
      albums.push(body);
      const prior = admitted.get(body.meta.message_id);
      if (prior && prior !== payload) return new Response('', { status: 409 });
      admitted.set(body.meta.message_id, payload);
    }
    return new Response('');
  });
  spool = new ReceiverSpool(root, 'http://callback', request, 0);
  expect(release).toBeDefined();
  spool.enqueue(album('2'));
  release!(); await tick(); await spool.flush(); await spool.flush();
  expect(albums).toHaveLength(1);
  expect(JSON.parse(albums[0].meta.message_ids_json)).toEqual(['1', '2']);
  expect(readdirSync(root).filter(file => file.endsWith('.json'))).toHaveLength(0);
});

test.each([undefined, 'not-json', 'null', '{}', '[]', '[1]', '[""]', JSON.stringify(Array.from({length:11},(_,i)=>String(i)))])(
  'invalid album member metadata %s retains its conversation while other chats progress across restart', async messageIds => {
    const metadata: Record<string,string> = { media_group_id:'album', message_id:'1' };
    if (messageIds !== undefined) metadata.message_ids_json = messageIds;
    const album = input('a','album',metadata);
    const broken = persist(root,album,10000);
    const original = readFileSync(join(root,broken),'utf8');
    persist(root,input('a','tail'),9000);
    persist(root,input('b','healthy'),8000);
    const diagnostic = jest.spyOn(process.stderr,'write').mockReturnValue(true);
    const request = jest.fn(async (_:any,init?:RequestInit)=>new Response(''));
    spool = new ReceiverSpool(root,'http://callback',request,0);
    await tick(); await spool.flush(); await spool.flush();
    expect(request.mock.calls.map(call=>JSON.parse(String(call[1]?.body)).content)).toEqual(['healthy']);
    expect(readFileSync(join(root,broken),'utf8')).toBe(original);
    expect(readdirSync(root).filter(file=>file.endsWith('.json'))).toHaveLength(2);
    expect(diagnostic).toHaveBeenCalledTimes(1);
    spool.close();
    persist(root,input('b','after restart'));
    spool = new ReceiverSpool(root,'http://callback',request,0);
    await tick(); await spool.flush();
    expect(request.mock.calls.map(call=>JSON.parse(String(call[1]?.body)).content)).toEqual(['healthy','after restart']);
    expect(readFileSync(join(root,broken),'utf8')).toBe(original);
    expect(diagnostic).toHaveBeenCalledTimes(2);
    // Repairing the retained record restores its original conversation order.
    writeFileSync(join(root,broken),JSON.stringify({...album,meta:{...metadata,...album.meta,message_ids_json:'["1"]'}}));
    utimesSync(join(root,broken),new Date(Date.now()-10000),new Date(Date.now()-10000));
    await spool.flush();
    expect(request.mock.calls.map(call=>JSON.parse(String(call[1]?.body)).content)).toEqual(['healthy','after restart','album','tail']);
    expect(readdirSync(root).filter(file=>file.endsWith('.json'))).toHaveLength(0);
  }
);
