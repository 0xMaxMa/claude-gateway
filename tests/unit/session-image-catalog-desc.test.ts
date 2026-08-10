/**
 * Unit tests for catalog metadata (`desc`) — the semantic half of the session
 * image catalog: generated images carry their generation prompt, uploads carry
 * the user text that came with the file, placeholders carry nothing. Also
 * covers the image_artifacts `prompt` column round-trip and the in-place
 * ALTER TABLE migration for DBs created before the column existed.
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

describe('session image catalog desc', () => {
  let baseDir: string;
  let store: ShareStore;
  let db: HistoryDB;
  let ts: number;

  const mediaRef = (file: string) => `media/${SESSION}/${file}`;

  const writeFile = (file: string) => {
    const dir = path.join(baseDir, AGENT, 'media', SESSION);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), PNG);
  };

  const say = (role: 'user' | 'assistant', content: string, files: string[]) => {
    db.insertMessage({
      chatId: `api-${SESSION}`,
      sessionId: SESSION,
      source: 'api',
      role,
      content,
      mediaFiles: files,
      ts: (ts += 1000),
    });
  };

  const catalog = () =>
    computeSessionImageCatalog({ agentsBaseDir: baseDir, store, agentId: AGENT, sessionId: SESSION });

  beforeEach(() => {
    baseDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'imgdesc-')));
    fs.mkdirSync(path.join(baseDir, AGENT, 'media', SESSION), { recursive: true });
    store = new ShareStore(path.join(baseDir, 'shares.db'));
    db = HistoryDB.forAgent(baseDir, AGENT);
    ts = 1_700_000_000_000;
  });

  afterEach(() => {
    store.close();
    HistoryDB.evict(baseDir, AGENT);
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  test('generated image carries its generation prompt as desc', () => {
    writeFile('gen.png');
    store.registerArtifact({
      agentId: AGENT,
      sessionId: SESSION,
      relativePath: `${SESSION}/gen.png`,
      provider: 'codex-image',
      model: 'gpt-image',
      prompt: 'a corgi with angel wings in a misty pine forest',
    });
    say('assistant', '', [mediaRef('gen.png')]);

    const [item] = catalog();
    expect(item!.origin).toBe('generated');
    expect(item!.desc).toBe('a corgi with angel wings in a misty pine forest');
  });

  test('generated image without a registered prompt has no desc', () => {
    writeFile('gen.png');
    store.registerArtifact({
      agentId: AGENT,
      sessionId: SESSION,
      relativePath: `${SESSION}/gen.png`,
      provider: 'p',
      model: 'm',
    });
    say('assistant', 'here is the image you asked for', [mediaRef('gen.png')]);

    const [item] = catalog();
    // assistant chatter is NOT a description of the image — generated items
    // only ever describe themselves through the persisted prompt.
    expect(item!.desc).toBeUndefined();
  });

  test('upload carries the accompanying user text as desc', () => {
    writeFile('up.png');
    say('user', 'turn this into a goat milk ad poster', [mediaRef('up.png')]);

    const [item] = catalog();
    expect(item!.origin).toBe('upload');
    expect(item!.desc).toBe('turn this into a goat milk ad poster');
  });

  test.each(['(photo)', '(Image)', '(sticker)', '', '   '])(
    'upload placeholder/empty content %j yields no desc',
    (content) => {
      writeFile('up.png');
      say('user', content, [mediaRef('up.png')]);

      const [item] = catalog();
      expect(item!.desc).toBeUndefined();
    },
  );

  test('desc is capped at 200 chars with an ellipsis', () => {
    writeFile('up.png');
    say('user', 'x'.repeat(500), [mediaRef('up.png')]);

    const [item] = catalog();
    expect(item!.desc).toHaveLength(201);
    expect(item!.desc!.endsWith('…')).toBe(true);
  });

  test('desc comes from the FIRST appearance, like every other catalog field', () => {
    writeFile('up.png');
    say('user', 'a corgi dog', [mediaRef('up.png')]);
    say('user', 'send it again', [mediaRef('up.png')]);

    const [item] = catalog();
    expect(item!.desc).toBe('a corgi dog');
  });
});

describe('image_artifacts prompt column', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'imgprompt-')));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  test('registerArtifact persists prompt; findArtifactByPath returns it', () => {
    const store = new ShareStore(path.join(baseDir, 'shares.db'));
    try {
      store.registerArtifact({
        agentId: AGENT,
        sessionId: SESSION,
        relativePath: `${SESSION}/a.png`,
        provider: 'p',
        model: 'm',
        prompt: 'space cat',
      });
      store.registerArtifact({
        agentId: AGENT,
        sessionId: SESSION,
        relativePath: `${SESSION}/b.png`,
        provider: 'p',
        model: 'm',
      });
      expect(store.findArtifactByPath(AGENT, SESSION, `${SESSION}/a.png`)?.prompt).toBe('space cat');
      expect(store.findArtifactByPath(AGENT, SESSION, `${SESSION}/b.png`)?.prompt).toBeNull();
      expect(store.findArtifactByPath(AGENT, SESSION, `${SESSION}/nope.png`)).toBeNull();
    } finally {
      store.close();
    }
  });

  test('opening a pre-prompt DB adds the column in place (migration guard)', () => {
    const dbPath = path.join(baseDir, 'legacy.db');
    // A DB exactly as the pre-desc code created it: no `prompt` column.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE image_artifacts (
        id            TEXT PRIMARY KEY,
        agent_id      TEXT NOT NULL,
        session_id    TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        provider      TEXT NOT NULL,
        model         TEXT NOT NULL,
        task_id       TEXT,
        image_index   INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL
      );
    `);
    legacy.prepare(
      `INSERT INTO image_artifacts (id, agent_id, session_id, relative_path, provider, model, image_index, created_at)
       VALUES ('img_old', ?, ?, ?, 'p', 'm', 0, 1)`,
    ).run(AGENT, SESSION, `${SESSION}/old.png`);
    legacy.close();

    const store = new ShareStore(dbPath);
    try {
      // Old row survives with a null prompt…
      expect(store.findArtifactByPath(AGENT, SESSION, `${SESSION}/old.png`)).toEqual({
        id: 'img_old',
        prompt: null,
      });
      // …and new writes can carry one.
      store.registerArtifact({
        agentId: AGENT,
        sessionId: SESSION,
        relativePath: `${SESSION}/new.png`,
        provider: 'p',
        model: 'm',
        prompt: 'fresh',
      });
      expect(store.findArtifactByPath(AGENT, SESSION, `${SESSION}/new.png`)?.prompt).toBe('fresh');
    } finally {
      store.close();
    }
  });
});
