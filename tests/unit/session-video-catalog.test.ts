/**
 * Unit tests for the deterministic session VIDEO catalog —
 * src/share/session-video-catalog.ts. The direct analogue of the image catalog
 * test, adapted to the two ways video differs: clips are classified by container
 * EXTENSION (not by sniffing bytes), and they carry NO artifact reference (a clip
 * must never enter the "Image N" surface). The contract under test is the same
 * ORDINAL guarantee — "video N" names the same file for the life of the session,
 * survives re-sends and deletions, and never reaches across sessions/agents.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HistoryDB } from '../../src/history/db';
import { computeSessionVideoCatalog } from '../../src/share/session-video-catalog';

const AGENT = 'a1';
const SESSION = 'session-1';

describe('computeSessionVideoCatalog', () => {
  let baseDir: string;
  let mediaDir: string;
  let db: HistoryDB;
  let ts: number;

  /** media_files as history really stores them: "media/<chat>/<file>". */
  const mediaRef = (file: string, session = SESSION) => `media/${session}/${file}`;

  const writeFile = (file: string, session = SESSION) => {
    const dir = path.join(baseDir, AGENT, 'media', session);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), Buffer.alloc(32, 7));
  };

  const say = (
    role: 'user' | 'assistant',
    files: string[],
    opts: { sessionId?: string; agentId?: string; content?: string } = {},
  ) => {
    const sessionId = opts.sessionId ?? SESSION;
    const target = opts.agentId ? HistoryDB.forAgent(baseDir, opts.agentId) : db;
    target.insertMessage({
      chatId: `api-${sessionId}`,
      sessionId,
      source: 'api',
      role,
      content: opts.content ?? 'msg',
      mediaFiles: files,
      ts: (ts += 1000),
    });
  };

  const catalog = (sessionId = SESSION, agentId = AGENT) =>
    computeSessionVideoCatalog({ agentsBaseDir: baseDir, agentId, sessionId });

  beforeEach(() => {
    baseDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vidcatalog-')));
    mediaDir = path.join(baseDir, AGENT, 'media', SESSION);
    fs.mkdirSync(mediaDir, { recursive: true });
    db = HistoryDB.forAgent(baseDir, AGENT);
    ts = 1_700_000_000_000;
  });

  afterEach(() => {
    HistoryDB.evict(baseDir, AGENT);
    HistoryDB.evict(baseDir, 'a2');
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  test('6 media occurrences across 4 unique clips → 4 items in first-appearance order', () => {
    for (const f of ['one.mp4', 'two.webm', 'three.mov', 'four.m4v']) writeFile(f);

    say('user', [mediaRef('one.mp4'), mediaRef('two.webm')]);
    say('assistant', [mediaRef('three.mov')]);
    say('user', [mediaRef('two.webm')]); // repeat
    say('user', [mediaRef('four.m4v'), mediaRef('one.mp4')]); // one repeat + one new

    const items = catalog();
    expect(items.map((i) => i.relative_path)).toEqual([
      `${SESSION}/one.mp4`,
      `${SESSION}/two.webm`,
      `${SESSION}/three.mov`,
      `${SESSION}/four.m4v`,
    ]);
    expect(items.map((i) => i.index)).toEqual([1, 2, 3, 4]);
    expect(items.every((i) => i.available)).toBe(true);
  });

  test('re-sending the same clip keeps its original ordinal and adds no entry', () => {
    writeFile('one.mp4');
    writeFile('two.mp4');

    say('user', [mediaRef('one.mp4')]);
    const before = catalog();

    say('user', [mediaRef('one.mp4')]);
    say('user', [mediaRef('two.mp4')]);
    say('assistant', [mediaRef('one.mp4')]);
    const after = catalog();

    expect(before).toHaveLength(1);
    expect(after).toHaveLength(2);
    // ordinal + origin + ts all come from the FIRST appearance
    expect(after[0]).toEqual(before[0]);
    expect(after[1]!.index).toBe(2);
  });

  test('origin follows the message role: assistant → generated, otherwise upload', () => {
    writeFile('up.mp4');
    writeFile('gen.mp4');

    say('user', [mediaRef('up.mp4')]);
    say('assistant', [mediaRef('gen.mp4')]);

    expect(catalog().map((i) => [i.index, i.origin])).toEqual([
      [1, 'upload'],
      [2, 'generated'],
    ]);
  });

  test('a clip deleted from disk stays listed as available:false without shifting ordinals', () => {
    for (const f of ['one.mp4', 'two.mp4', 'three.mp4']) writeFile(f);
    say('user', [mediaRef('one.mp4'), mediaRef('two.mp4'), mediaRef('three.mp4')]);

    fs.unlinkSync(path.join(mediaDir, 'two.mp4'));

    const items = catalog();
    expect(items.map((i) => [i.index, i.relative_path, i.available])).toEqual([
      [1, `${SESSION}/one.mp4`, true],
      [2, `${SESSION}/two.mp4`, false],
      [3, `${SESSION}/three.mp4`, true],
    ]);
  });

  test('rows from another session or another agent are never included', () => {
    writeFile('mine.mp4');
    writeFile('theirs.mp4', 'session-2');
    writeFile('other-agent.mp4');

    say('user', [mediaRef('mine.mp4')]);
    say('user', [mediaRef('theirs.mp4', 'session-2')], { sessionId: 'session-2' });
    say('user', [mediaRef('other-agent.mp4')], { agentId: 'a2' });

    expect(catalog().map((i) => i.relative_path)).toEqual([`${SESSION}/mine.mp4`]);
    expect(catalog('session-2').map((i) => i.relative_path)).toEqual(['session-2/theirs.mp4']);
    expect(catalog(SESSION, 'a2').map((i) => i.relative_path)).toEqual([
      `${SESSION}/other-agent.mp4`,
    ]);
  });

  test('non-video media are excluded and malformed media_files rows are skipped', () => {
    writeFile('photo.png');
    writeFile('first.mp4');
    writeFile('broken.mp4');
    writeFile('last.webm');

    say('user', [mediaRef('photo.png'), mediaRef('first.mp4')]);
    say('user', [mediaRef('broken.mp4')]); // corrupted below
    say('user', [mediaRef('last.webm')]);

    // Corrupt the middle row's media_files the way a truncated write would.
    const raw = new DatabaseSync(path.join(baseDir, AGENT, 'history.db'));
    raw.prepare(`UPDATE messages SET media_files = ? WHERE content = 'msg' AND ts = ?`).run(
      '["media/session-1/broken.mp4"',
      ts - 1000,
    );
    raw.close();

    const items = catalog();
    expect(items.map((i) => [i.index, i.relative_path])).toEqual([
      [1, `${SESSION}/first.mp4`],
      [2, `${SESSION}/last.webm`],
    ]);
  });

  test('a media-root-relative path and its media/-prefixed form are one entry', () => {
    writeFile('same.mp4');
    say('user', [mediaRef('same.mp4')]);
    say('assistant', [`${SESSION}/same.mp4`]);

    const items = catalog();
    expect(items).toHaveLength(1);
    expect(items[0]!.origin).toBe('upload'); // first appearance wins
  });

  test('a session with no video yields an empty catalog', () => {
    expect(catalog('empty-session')).toEqual([]);
  });

  describe('desc — the accompanying message text', () => {
    test('meaningful message text becomes the desc', () => {
      writeFile('clip.mp4');
      say('assistant', [mediaRef('clip.mp4')], { content: 'a pug doing a backflip' });
      expect(catalog()[0]!.desc).toBe('a pug doing a backflip');
    });

    test('a bare "(video)" placeholder describes nothing → no desc', () => {
      writeFile('clip.mp4');
      say('user', [mediaRef('clip.mp4')], { content: '(video)' });
      expect(catalog()[0]!.desc).toBeUndefined();
    });

    test('desc is truncated with an ellipsis past the cap', () => {
      writeFile('clip.mp4');
      const long = 'x'.repeat(500);
      say('assistant', [mediaRef('clip.mp4')], { content: long });
      const desc = catalog()[0]!.desc!;
      expect(desc.endsWith('…')).toBe(true);
      expect(desc.length).toBe(201); // 200 chars + ellipsis
    });
  });
});
