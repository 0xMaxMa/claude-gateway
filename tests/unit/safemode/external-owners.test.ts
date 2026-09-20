import fs from 'fs';
import { assertNoExternalNativeOwner, findExternalNativeOwners } from '../../../src/safemode/external-owners';

const id = '11111111-2222-4333-8444-555555555555';
const options = { cli: 'claude' as const, nativeSessionId: id, cwd: '/safe/work', env: { HOME: '/fixture' } };
const entries = new Map<string, string | string[]>();
function stat(pid: number, start = '12345', parent = 1): string {
  return `${pid} (native cli) ${['S', String(parent), ...Array(17).fill('0'), start].join(' ')}`;
}
function processFixture(pid: number, cli: string, args = '', cwd = '/outside', parent = 1) {
  entries.set(`/proc/${pid}/stat`, stat(pid, '12345', parent));
  entries.set(`/proc/${pid}/cmdline`, `${cli}\0${args.split(' ').join('\0')}\0`);
  entries.set(`/proc/${pid}/exe`, `/bin/${cli}`);
  entries.set(`/proc/${pid}/environ`, 'HOME=/fixture\0');
  entries.set(`/proc/${pid}/cwd`, cwd);
  entries.set(`/proc/${pid}/fd`, []);
  entries.set('/proc', [...entries.keys()].filter(key => /^\/proc\/\d+\/stat$/.test(key)).map(key => key.split('/')[2]));
}
function register(pid: number, extra: object = {}) {
  entries.set(`/fixture/.claude/sessions/${pid}.json`, JSON.stringify({ pid, sessionId: id, cwd: '/outside', procStart: '12345', ...extra }));
  entries.set('/fixture/.claude/sessions', [...entries.keys()].filter(key => key.startsWith('/fixture/.claude/sessions/')).map(key => key.split('/').at(-1)!));
}
beforeEach(() => {
  entries.clear(); entries.set('/proc', []);
  const get = (p: fs.PathLike | number): string | string[] => {
    const value = entries.get(String(p));
    if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return value;
  };
  jest.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike) => get(p)) as typeof fs.readdirSync);
  jest.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathLike) => get(p)) as typeof fs.readFileSync);
  jest.spyOn(fs, 'readlinkSync').mockImplementation(((p: fs.PathLike) => get(p)) as typeof fs.readlinkSync);
  jest.spyOn(fs, 'statSync').mockReturnValue({ uid: process.getuid!() } as fs.Stats);
});
afterEach(() => jest.restoreAllMocks());

it('finds a Claude resume-picker owner from the native registry without a UUID in argv', () => {
  processFixture(9001, 'claude', '--continue'); register(9001);
  expect(() => assertNoExternalNativeOwner(options)).toThrow('external native CLI process 9001');
  expect(findExternalNativeOwners(options)).toEqual([{ pid: 9001 }]);
});
it('allows a positively identified unrelated native conversation even in the same directory', () => {
  processFixture(9001, 'claude', '--continue', options.cwd); register(9001, { sessionId: 'other' });
  expect(() => assertNoExternalNativeOwner(options)).not.toThrow();
});
it('does not attribute an old PID registration to a reused unrelated process', () => {
  processFixture(9001, 'unrelated'); register(9001, { procStart: 'old-start' });
  expect(findExternalNativeOwners(options)).toEqual([]);
});
it('refuses unknown ownership for live Claude without a current registry', () => {
  processFixture(9001, 'claude', '--continue');
  expect(() => assertNoExternalNativeOwner(options)).toThrow('no current native session registration');
});
it('excludes the verified managed child and its native descendants', () => {
  processFixture(9001, 'launcher'); processFixture(9002, 'claude', '--continue', '/outside', 9001); register(9002);
  expect(() => assertNoExternalNativeOwner({ ...options, ignorePids: [9001] })).not.toThrow();
});
it('detects direct external Codex resume from another directory', () => {
  processFixture(9001, 'codex', `resume ${id}`);
  expect(findExternalNativeOwners({ ...options, cli: 'codex' })).toEqual([{ pid: 9001 }]);
});
it('finds Codex app-server ownership through its native writer-lock descriptor', () => {
  processFixture(9001, 'codex', 'app-server');
  entries.set('/proc/9001/fd', ['6']);
  entries.set('/proc/9001/fd/6', `/fixture/.codex/thread-writer-locks/${id}.lock`);
  expect(() => assertNoExternalNativeOwner({ ...options, cli: 'codex' })).toThrow('9001');
});
it('does not confuse a stale Codex lock file with a running writer', () => {
  entries.set(`/fixture/.codex/thread-writer-locks/${id}.lock`, '');
  processFixture(9001, 'codex', 'app-server');
  expect(findExternalNativeOwners({ ...options, cli: 'codex' })).toEqual([]);
});
it('does not inspect or disclose arbitrary prompt UUIDs', () => {
  processFixture(9001, 'codex', `exec secret-prompt-${id}`);
  expect(findExternalNativeOwners({ ...options, cli: 'codex' })).toEqual([]);
});
it('refuses unreadable process metadata instead of claiming it is idle', () => {
  processFixture(9001, 'codex');
  jest.spyOn(fs, 'readlinkSync').mockImplementation(() => { throw Object.assign(new Error('private data'), { code: 'EACCES' }); });
  expect(() => assertNoExternalNativeOwner({ ...options, cli: 'codex' })).toThrow('metadata is inaccessible');
});
it('reports multiple external Claude owners without exposing their argv', () => {
  processFixture(9001, 'claude'); register(9001);
  processFixture(9002, 'claude'); register(9002);
  expect(findExternalNativeOwners(options)).toEqual([{ pid: 9001 }, { pid: 9002 }]);
});

it('ignores unrelated Claude using an isolated native home', () => {
  processFixture(9001, 'claude', '--continue');
  entries.set('/proc/9001/environ', 'HOME=/different-home\0PRIVATE_TOKEN=never-disclose\0');
  expect(findExternalNativeOwners(options)).toEqual([]);
});
it('does not require private exe or environment metadata from unrelated daemons', () => {
  processFixture(9001, 'daemon');
  jest.spyOn(fs, 'readlinkSync').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
  expect(findExternalNativeOwners(options)).toEqual([]);
});
