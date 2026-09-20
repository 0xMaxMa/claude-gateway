import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { prepareContext, sanitizeDiagnostic } from '../../../src/safemode/context';
import { captureRuntimeProvenance, readRuntimeProvenance, isRecordedRuntimeAlive } from '../../../src/safemode/provenance';

jest.mock('../../../src/safemode/provenance', () => ({
  readRuntimeProvenance: jest.fn(), captureRuntimeProvenance: jest.fn(), isRecordedRuntimeAlive: jest.fn(),
}));

const ID = '11111111-2222-4333-8444-555555555555';
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
let root: string;
let config: string;
let workspace: string;
const savedFetch = global.fetch;
const savedConfig = process.env.GATEWAY_CONFIG;

beforeEach(() => {
  jest.resetAllMocks();
  delete process.env.GATEWAY_CONFIG;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'safemode-context-'));
  config = path.join(root, 'config.json');
  workspace = path.join(root, 'investigation');
  fs.mkdirSync(path.join(root, 'logs'));
  fs.writeFileSync(config, JSON.stringify({ gateway: { logDir: path.join(root, 'logs'), api: { keys: [{ key: 'short-secret' }] } }, password: 'tiny' }));
  (readRuntimeProvenance as jest.Mock).mockReturnValue(null);
  (captureRuntimeProvenance as jest.Mock).mockReturnValue({ packageVersion: '9.8.7', build: { commit: 'f'.repeat(40) } });
  global.fetch = jest.fn().mockRejectedValue(new Error('offline'));
});
afterEach(() => {
  global.fetch = savedFetch;
  if (savedConfig === undefined) delete process.env.GATEWAY_CONFIG; else process.env.GATEWAY_CONFIG = savedConfig;
  fs.rmSync(root, { recursive: true, force: true });
});

function artifact(name: string): any { return JSON.parse(fs.readFileSync(path.join(workspace, 'diagnostics', name), 'utf8')); }

test('offline old builds never substitute the launcher/main revision and keep redacted correlation evidence', async () => {
  fs.writeFileSync(path.join(root, 'logs', 'gateway.log'), `session=${ID} Authorization: Bearer sensitiveToken\napi_key=small\ncookie=abc\n`);
  const result = await prepareContext(workspace, config);
  expect(result.sourcePath).toBeUndefined();
  expect(artifact('provenance.json').evidenceKind).toBe('safemode-launcher-only');
  expect(artifact('coverage.json').notes.join(' ')).toContain('Exact gateway build revision unknown');
  const log = JSON.stringify(artifact('logs.json'));
  expect(log).toContain(ID);
  expect(log).not.toMatch(/sensitiveToken|small|abc/);
  expect(JSON.stringify(artifact('config.json'))).not.toMatch(/short-secret|tiny/);
  expect(artifact('health.json')).toEqual({ status: 'unavailable' });
  expect(fs.statSync(path.join(workspace, 'diagnostics', 'config.json')).mode & 0o777).toBe(0o600);
});

test('snapshots read live WAL state without modifying the database, and target the requested session', async () => {
  const dir = path.join(root, 'agents', 'example'); fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'orchestration.db'));
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE conversations(id TEXT, agent_session_id TEXT); CREATE TABLE conversation_events(conversation_id TEXT, payload_json TEXT);');
    db.prepare('INSERT INTO conversations VALUES (?,?)').run('old-conversation', ID);
    db.prepare('INSERT INTO conversations VALUES (?,?)').run('new-conversation', OTHER);
    db.prepare('INSERT INTO conversation_events VALUES (?,?)').run('old-conversation', JSON.stringify({ text: 'voice interrupted', secret: 'short-value' }));
    db.prepare('INSERT INTO conversation_events VALUES (?,?)').run('new-conversation', JSON.stringify({ text: 'unrelated' }));
    const before = db.prepare('SELECT * FROM conversation_events').all();
    await prepareContext(workspace, config, `Inspect gateway session ${ID}`);
    const evidence = artifact('databases.json')['example/orchestration.db'];
    expect(evidence.tables.conversations).toEqual([{ id: 'old-conversation', agent_session_id: ID }]);
    expect(evidence.tables.conversation_events).toEqual([{ conversation_id: 'old-conversation', payload_json: { text: 'voice interrupted', secret: '[redacted]' } }]);
    expect(db.prepare('SELECT * FROM conversation_events').all()).toEqual(before);
  } finally { db.close(); }
});

test('refresh preserves prior evidence and refuses a startup record belonging to a different config', async () => {
  (readRuntimeProvenance as jest.Mock).mockReturnValue({ configPath: '/different/config.json', build: { commit: 'a'.repeat(40) } });
  await prepareContext(workspace, config);
  expect(artifact('coverage.json').notes.join(' ')).toContain('different or unknown config');
  await prepareContext(workspace, config);
  expect(fs.readdirSync(workspace).filter(name => name.startsWith('diagnostics-previous-'))).toHaveLength(1);
});

test('dead startup evidence is clearly labelled last-run, and bounded logs exclude symlinks', async () => {
  (readRuntimeProvenance as jest.Mock).mockReturnValue({ configPath: config, build: null });
  (isRecordedRuntimeAlive as jest.Mock).mockReturnValue(false);
  fs.writeFileSync(path.join(root, 'private.txt'), 'do not include');
  fs.symlinkSync(path.join(root, 'private.txt'), path.join(root, 'logs', 'secret.log'));
  fs.writeFileSync(path.join(root, 'logs', 'large.log'), 'old content\n' + 'x'.repeat(150000) + '\nlast event\n');
  await prepareContext(workspace, config);
  expect(artifact('provenance.json').runtimeStatus).toContain('last-run');
  const logs = artifact('logs.json').logs;
  expect(logs['secret.log']).toBeUndefined();
  expect(logs['large.log']).toContain('last event');
  expect(logs['large.log']).not.toContain('old content');
});

test('nested JSON credentials and short secrets are removed while diagnostic UUIDs remain useful', () => {
  expect(sanitizeDiagnostic({ payload_json: JSON.stringify({ session_id: ID, credentials: { foo: 'bar' }, text: 'access_token=short' }) }))
    .toEqual({ payload_json: { session_id: ID, credentials: '[redacted]', text: '[credential]=[redacted]' } });
});

test('canonical source uses the build SHA, never startup checkout HEAD, and preserves edited prior snapshots', async () => {
  const originalPath = process.env.PATH;
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const calls = path.join(root, 'git-calls.jsonl');
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
const fs=require('fs'), path=require('path'); const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+'\\n');
if(args[0]==='init') fs.mkdirSync(args[args.length-1],{recursive:true});
else if(args.includes('fetch')) fs.writeFileSync(path.join(args[1],'revision'),args[args.length-1].startsWith('refs/')?'a'.repeat(40):args[args.length-1]);
else if(args.includes('rev-parse')) process.stdout.write(fs.readFileSync(path.join(args[1],'revision'),'utf8')+'\\n');
else if(args.includes('checkout')) { fs.writeFileSync(path.join(args[1],'source.ts'),'original'); fs.writeFileSync(path.join(args[1],'package.json'),JSON.stringify({version:'9.8.7'})); }
else process.exit(1);
`, { mode: 0o700 });
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
  const commit = 'a'.repeat(40);
  (readRuntimeProvenance as jest.Mock).mockReturnValue({ configPath: config, build: { commit }, checkoutAtStartup: { commit: 'b'.repeat(40) }, sourceConfidence: 'exact-build' });
  try {
    const first = await prepareContext(workspace, config);
    expect(first.sourcePath).toBe(path.join(workspace, `source-${commit}`));
    const beforeReuse = fs.readFileSync(calls, 'utf8');
    await prepareContext(workspace, config);
    expect(fs.readFileSync(calls, 'utf8')).toBe(beforeReuse);
    fs.writeFileSync(path.join(first.sourcePath!, 'source.ts'), 'investigation edits');
    const second = await prepareContext(workspace, config);
    expect(fs.readFileSync(path.join(second.sourcePath!, 'source.ts'), 'utf8')).toBe('original');
    const previous = fs.readdirSync(workspace).find(name => name.startsWith(`source-${commit}.previous-`));
    expect(fs.readFileSync(path.join(workspace, previous!, 'source.ts'), 'utf8')).toBe('investigation edits');
    const operations = fs.readFileSync(calls, 'utf8');
    expect(operations).toContain('https://github.com/0xMaxMa/claude-gateway.git');
    expect(operations).toContain(commit);
    expect(operations).not.toContain('b'.repeat(40));
    expect(operations).not.toMatch(/"pull"|"reset"/);
    (readRuntimeProvenance as jest.Mock).mockReturnValue({ configPath: config, build: null, packageVersion: '9.8.7' });
    const release = await prepareContext(workspace, config);
    expect(release.sourcePath).toBe(path.join(workspace, 'source-v9.8.7'));
    expect(artifact('coverage.json').notes.join(' ')).toContain('NOT verified running code');
    (readRuntimeProvenance as jest.Mock).mockReturnValue({ configPath: config, build: null, packageVersion: '9.8.6' });
    expect((await prepareContext(workspace, config)).sourcePath).toBeUndefined();
    expect(artifact('coverage.json').notes.join(' ')).toContain('version mismatch');
  } finally { process.env.PATH = originalPath; }
});

test('targeted evidence includes agents beyond the first eight without unrelated snapshots', async () => {
  for (let i = 0; i < 10; i++) {
    const dir = path.join(root, 'agents', `agent-${String(i).padStart(2,'0')}`);
    fs.mkdirSync(dir, {recursive:true});
    const db = new DatabaseSync(path.join(dir, 'orchestration.db'));
    db.exec('CREATE TABLE conversations(id TEXT, agent_session_id TEXT);');
    db.prepare('INSERT INTO conversations VALUES (?,?)').run(`conversation-${i}`, i === 9 ? ID : OTHER);
    db.close();
  }
  await prepareContext(workspace, config, `Investigate ${ID}`);
  const evidence = artifact('databases.json');
  expect(Object.keys(evidence)).toEqual(['agent-09/orchestration.db']);
  expect(evidence['agent-09/orchestration.db'].tables.conversations[0].agent_session_id).toBe(ID);
});

test('unmatched target IDs are reported instead of substituting unrelated rows', async () => {
  const dir = path.join(root,'agents','example'); fs.mkdirSync(dir,{recursive:true});
  const db = new DatabaseSync(path.join(dir,'orchestration.db'));
  db.exec('CREATE TABLE conversations(id TEXT, agent_session_id TEXT);');
  db.prepare('INSERT INTO conversations VALUES (?,?)').run('other',OTHER); db.close();
  await prepareContext(workspace,config,ID);
  expect(artifact('databases.json')).toEqual({});
  expect(artifact('coverage.json').notes).toContain('No matching database evidence found for the requested IDs.');
});
