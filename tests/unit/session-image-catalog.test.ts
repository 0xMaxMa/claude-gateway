/**
 * Unit tests for the deterministic session image catalog (#72) —
 * src/share/session-image-catalog.ts. The contract under test is the ORDINAL:
 * "image N" must mean the same file for the agent and for the UI, must not move
 * when a file is re-sent or deleted, and must never reach across sessions/agents.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HistoryDB } from '../../src/history/db';
import { ShareStore } from '../../src/share/share-store';
import { computeSessionImageCatalog } from '../../src/share/session-image-catalog';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);

const AGENT = 'a1';
const SESSION = 'session-1';

describe('computeSessionImageCatalog (#72)', () => {
  let baseDir: string;
  let mediaDir: string;
  let store: ShareStore;
  let db: HistoryDB;
  let ts: number;

  /** media_files as history really stores them: "media/<chat>/<file>". */
  const mediaRef = (file: string, session = SESSION) => `media/${session}/${file}`;

  const writeFile = (file: string, session = SESSION) => {
    const dir = path.join(baseDir, AGENT, 'media', session);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), PNG);
  };

  const say = (
    role: 'user' | 'assistant',
    files: string[],
    opts: { sessionId?: string; agentId?: string } = {},
  ) => {
    const sessionId = opts.sessionId ?? SESSION;
    const target = opts.agentId ? HistoryDB.forAgent(baseDir, opts.agentId) : db;
    target.insertMessage({
      chatId: `api-${sessionId}`,
      sessionId,
      source: 'api',
      role,
      content: 'msg',
      mediaFiles: files,
      ts: (ts += 1000),
    });
  };

  const catalog = (sessionId = SESSION, agentId = AGENT) =>
    computeSessionImageCatalog({ agentsBaseDir: baseDir, store, agentId, sessionId });

  beforeEach(() => {
    baseDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'imgcatalog-')));
    mediaDir = path.join(baseDir, AGENT, 'media', SESSION);
    fs.mkdirSync(mediaDir, { recursive: true });
    store = new ShareStore(path.join(baseDir, 'shares.db'));
    db = HistoryDB.forAgent(baseDir, AGENT);
    ts = 1_700_000_000_000;
  });

  afterEach(() => {
    store.close();
    HistoryDB.evict(baseDir, AGENT);
    HistoryDB.evict(baseDir, 'a2');
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  test('6 media occurrences across 4 unique files → 4 items in first-appearance order', () => {
    for (const f of ['one.png', 'two.png', 'three.png', 'four.png']) writeFile(f);

    say('user', [mediaRef('one.png'), mediaRef('two.png')]);
    say('assistant', [mediaRef('three.png')]);
    say('user', [mediaRef('two.png')]); // repeat
    say('user', [mediaRef('four.png'), mediaRef('one.png')]); // one repeat + one new

    const items = catalog();
    expect(items.map((i) => i.relative_path)).toEqual([
      `${SESSION}/one.png`,
      `${SESSION}/two.png`,
      `${SESSION}/three.png`,
      `${SESSION}/four.png`,
    ]);
    expect(items.map((i) => i.index)).toEqual([1, 2, 3, 4]);
    expect(items.every((i) => i.available)).toBe(true);
  });

  test('re-sending the same path keeps its original ordinal and adds no entry', () => {
    writeFile('one.png');
    writeFile('two.png');

    say('user', [mediaRef('one.png')]);
    const before = catalog();

    say('user', [mediaRef('one.png')]);
    say('user', [mediaRef('two.png')]);
    say('assistant', [mediaRef('one.png')]);
    const after = catalog();

    expect(before).toHaveLength(1);
    expect(after).toHaveLength(2);
    // ordinal + origin + ts all come from the FIRST appearance
    expect(after[0]).toEqual(before[0]);
    expect(after[1]!.index).toBe(2);
  });

  test('origin follows the message role: assistant → generated, otherwise upload', () => {
    writeFile('up.png');
    writeFile('gen.png');
    writeFile('sys.png');

    say('user', [mediaRef('up.png')]);
    say('assistant', [mediaRef('gen.png')]);
    db.insertMessage({
      chatId: `api-${SESSION}`,
      sessionId: SESSION,
      source: 'api',
      role: 'system',
      content: 'note',
      mediaFiles: [mediaRef('sys.png')],
      ts: (ts += 1000),
    });

    expect(catalog().map((i) => [i.index, i.origin])).toEqual([
      [1, 'upload'],
      [2, 'generated'],
      [3, 'upload'],
    ]);
  });

  test('a file deleted from disk stays listed as available:false without shifting ordinals', () => {
    for (const f of ['one.png', 'two.png', 'three.png']) writeFile(f);
    say('user', [mediaRef('one.png'), mediaRef('two.png'), mediaRef('three.png')]);

    fs.unlinkSync(path.join(mediaDir, 'two.png'));

    const items = catalog();
    expect(items.map((i) => [i.index, i.relative_path, i.available])).toEqual([
      [1, `${SESSION}/one.png`, true],
      [2, `${SESSION}/two.png`, false],
      [3, `${SESSION}/three.png`, true],
    ]);
  });

  test('ref is artifact:<id> when the path is a registered artifact, else the path itself', () => {
    writeFile('plain.png');
    writeFile('generated.png');
    const artifactId = store.registerArtifact({
      agentId: AGENT,
      sessionId: SESSION,
      relativePath: `${SESSION}/generated.png`,
      provider: 'codex-image',
      model: 'gpt-image',
    });

    say('user', [mediaRef('plain.png')]);
    say('assistant', [mediaRef('generated.png')]);

    const items = catalog();
    expect(items[0]!.ref).toBe(`${SESSION}/plain.png`);
    expect(items[1]!.ref).toBe(`artifact:${artifactId}`);
  });

  test('artifacts of another session/agent do not leak into the ref', () => {
    writeFile('shared-name.png');
    store.registerArtifact({
      agentId: AGENT,
      sessionId: 'other-session',
      relativePath: `${SESSION}/shared-name.png`,
      provider: 'codex-image',
      model: 'gpt-image',
    });
    store.registerArtifact({
      agentId: 'a2',
      sessionId: SESSION,
      relativePath: `${SESSION}/shared-name.png`,
      provider: 'codex-image',
      model: 'gpt-image',
    });

    say('user', [mediaRef('shared-name.png')]);
    expect(catalog()[0]!.ref).toBe(`${SESSION}/shared-name.png`);
  });

  test('rows from another session or another agent are never included', () => {
    writeFile('mine.png');
    writeFile('theirs.png', 'session-2');
    writeFile('other-agent.png');

    say('user', [mediaRef('mine.png')]);
    say('user', [mediaRef('theirs.png', 'session-2')], { sessionId: 'session-2' });
    say('user', [mediaRef('other-agent.png')], { agentId: 'a2' });

    expect(catalog().map((i) => i.relative_path)).toEqual([`${SESSION}/mine.png`]);
    expect(catalog('session-2').map((i) => i.relative_path)).toEqual(['session-2/theirs.png']);
    expect(catalog(SESSION, 'a2').map((i) => i.relative_path)).toEqual([`${SESSION}/other-agent.png`]);
  });

  test('non-image media are excluded and malformed media_files rows are skipped', () => {
    writeFile('doc.pdf');
    writeFile('first.png');
    writeFile('broken.png');
    writeFile('last.jpeg');

    say('user', [mediaRef('doc.pdf'), mediaRef('first.png')]);
    say('user', [mediaRef('broken.png')]); // corrupted below
    say('user', [mediaRef('last.jpeg')]);

    // Corrupt the middle row's media_files the way a truncated write would.
    const raw = new DatabaseSync(path.join(baseDir, AGENT, 'history.db'));
    raw.prepare(`UPDATE messages SET media_files = ? WHERE content = 'msg' AND ts = ?`).run(
      '["media/session-1/broken.png"',
      ts - 1000,
    );
    raw.close();

    const items = catalog();
    expect(items.map((i) => [i.index, i.relative_path])).toEqual([
      [1, `${SESSION}/first.png`],
      [2, `${SESSION}/last.jpeg`],
    ]);
  });

  test('a media-root-relative path and its media/-prefixed form are one entry', () => {
    writeFile('same.png');
    say('user', [mediaRef('same.png')]);
    say('assistant', [`${SESSION}/same.png`]);

    const items = catalog();
    expect(items).toHaveLength(1);
    expect(items[0]!.origin).toBe('upload'); // first appearance wins
  });

  test('a session with no media yields an empty catalog', () => {
    expect(catalog('empty-session')).toEqual([]);
  });

  test('a .bin upload whose bytes are an image IS catalogued (#74 clipboard paste)', () => {
    // Legacy naming: extensionless uploads were stored as .bin — the bytes,
    // not the name, decide whether it is a referenceable image.
    writeFile('paste.bin');
    say('user', [mediaRef('paste.bin')]);
    const items = catalog();
    expect(items).toHaveLength(1);
    expect(items[0]!.relative_path).toBe(`${SESSION}/paste.bin`);
    expect(items[0]!.available).toBe(true);
  });

  test('a .bin file that is not an image stays out of the catalog', () => {
    const dir = path.join(baseDir, AGENT, 'media', SESSION);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'notes.bin'), Buffer.from('just some text'));
    say('user', [mediaRef('notes.bin')]);
    expect(catalog()).toEqual([]);
  });

  test('a .bin entry whose file is gone is not catalogued (bytes unverifiable)', () => {
    say('user', [mediaRef('ghost.bin')]);
    expect(catalog()).toEqual([]);
  });
});
