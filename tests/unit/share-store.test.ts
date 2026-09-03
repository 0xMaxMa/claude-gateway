/**
 * Unit tests for the image share/artifact store (#70) —
 * src/share/share-store.ts. Covers plan §20.1 store-level items:
 * token format + hash-only persistence, idempotent mint (§17.4), lazy expiry,
 * artifact agent/session binding, and the full §12 filesystem validation set
 * (traversal, symlink escape, non-regular files, magic bytes, size caps).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  ShareStore,
  ShareError,
  SHARE_TOKEN_RE,
  validateShareFile,
  detectImageMime,
  detectShareMime,
  shareEnv,
  shareLimitsFromEnv,
  DEFAULT_MAX_REFS,
} from '../../src/share/share-store';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x40, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP'),
  Buffer.alloc(64, 3),
]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 5)]);

const AGENT = 'a1';
const SESSION = 'session-1';

// #444: the share bridge's env vars were renamed IMAGE_SHARE_* -> SHARE_*.
// Both names stay readable so an existing deployment does not silently lose its
// tuning on upgrade, and the neutral name wins when both are set.
describe('shareEnv dual-read (#444)', () => {
  const KEYS = ['SHARE_MAX_REFS', 'IMAGE_SHARE_MAX_REFS'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test('neither set → undefined, and the limit falls back to its default', () => {
    expect(shareEnv('MAX_REFS')).toBeUndefined();
    expect(shareLimitsFromEnv().maxRefs).toBe(DEFAULT_MAX_REFS);
  });

  test('only the legacy name set → legacy value is used', () => {
    process.env.IMAGE_SHARE_MAX_REFS = '3';
    expect(shareEnv('MAX_REFS')).toBe('3');
    expect(shareLimitsFromEnv().maxRefs).toBe(3);
  });

  test('only the neutral name set → neutral value is used', () => {
    process.env.SHARE_MAX_REFS = '7';
    expect(shareEnv('MAX_REFS')).toBe('7');
    expect(shareLimitsFromEnv().maxRefs).toBe(7);
  });

  test('both set → the neutral name wins', () => {
    process.env.SHARE_MAX_REFS = '7';
    process.env.IMAGE_SHARE_MAX_REFS = '3';
    expect(shareEnv('MAX_REFS')).toBe('7');
    expect(shareLimitsFromEnv().maxRefs).toBe(7);
  });

  // src/session/process.ts forwards UNSET vars to the MCP subprocess as '',
  // so an empty neutral name must not shadow a genuinely-set legacy one.
  test('empty neutral name does not shadow a set legacy name', () => {
    process.env.SHARE_MAX_REFS = '';
    process.env.IMAGE_SHARE_MAX_REFS = '3';
    expect(shareEnv('MAX_REFS')).toBe('3');
    expect(shareLimitsFromEnv().maxRefs).toBe(3);
  });

  test('both empty → undefined, not the empty string', () => {
    process.env.SHARE_MAX_REFS = '';
    process.env.IMAGE_SHARE_MAX_REFS = '';
    expect(shareEnv('MAX_REFS')).toBeUndefined();
    expect(shareLimitsFromEnv().maxRefs).toBe(DEFAULT_MAX_REFS);
  });
});

describe('image share store', () => {
  let baseDir: string; // agentsBaseDir
  let mediaDir: string; // agents/a1/media/session-1
  let dbPath: string;
  let store: ShareStore;

  beforeEach(() => {
    // realpath: macOS tmpdir is a symlink (/var → /private/var); the store
    // compares canonical paths, so the fixture root must be canonical too.
    baseDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'imgshare-')));
    mediaDir = path.join(baseDir, AGENT, 'media', SESSION);
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(mediaDir, 'ok.png'), PNG);
    dbPath = path.join(baseDir, 'shares.db');
    store = new ShareStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const mint = (overrides: Partial<Parameters<ShareStore['mintShare']>[0]> = {}) =>
    store.mintShare({
      agentId: AGENT,
      sessionId: SESSION,
      relativePath: `${SESSION}/ok.png`,
      dedupeRef: `path:${SESSION}/ok.png`,
      purpose: 'codex_ref',
      ttlSeconds: 1800,
      ...overrides,
    });

  describe('token + persistence (§9)', () => {
    test('token is 32-char base64url and lookup round-trips', () => {
      const m = mint();
      expect(m.token).toMatch(SHARE_TOKEN_RE);
      const row = store.lookupByToken(m.token);
      expect(row).not.toBeNull();
      expect(row!.shareId).toBe(m.shareId);
      expect(row!.agentId).toBe(AGENT);
      expect(row!.relativePath).toBe(`${SESSION}/ok.png`);
    });

    test('only the SHA-256 hash is persisted — plaintext token never touches the DB', () => {
      const m = mint();
      const raw = new DatabaseSync(dbPath);
      const row = raw
        .prepare('SELECT token_hash, id, agent_id, session_id, relative_path, purpose FROM file_shares')
        .get() as Record<string, unknown>;
      raw.close();
      const expectedHash = createHash('sha256').update(m.token).digest();
      expect(Buffer.from(row.token_hash as Uint8Array).equals(expectedHash)).toBe(true);
      for (const [col, v] of Object.entries(row)) {
        if (col === 'token_hash') continue;
        expect(String(v)).not.toContain(m.token);
      }
    });

    test('lookup rejects malformed tokens without touching the DB row shape', () => {
      mint();
      expect(store.lookupByToken('short')).toBeNull();
      expect(store.lookupByToken('../../../etc/passwd')).toBeNull();
      expect(store.lookupByToken('x'.repeat(64))).toBeNull();
    });
  });

  describe('idempotent mint (§17.4)', () => {
    test('same (agent, session, ref, purpose) within the window returns the SAME token/share', () => {
      const a = mint();
      const b = mint();
      expect(b.token).toBe(a.token);
      expect(b.shareId).toBe(a.shareId);
      expect(b.deduped).toBe(true);
    });

    test('different purpose or ref mints a fresh token', () => {
      const a = mint();
      const b = mint({ purpose: 'other_use' });
      const c = mint({ dedupeRef: 'artifact:img_x' });
      expect(b.token).not.toBe(a.token);
      expect(c.token).not.toBe(a.token);
    });

    test('revoking evicts the dedupe entry — next mint issues a fresh token', () => {
      const a = mint();
      store.revokeShare(a.shareId);
      const b = mint();
      expect(b.token).not.toBe(a.token);
      expect(b.deduped).toBe(false);
    });
  });

  describe('expiry + revocation', () => {
    test('expired share is not returned and cleanupExpired deletes it', () => {
      const m = mint({ ttlSeconds: 0 });
      expect(store.lookupByToken(m.token)).toBeNull();
      store.cleanupExpired();
      const raw = new DatabaseSync(dbPath);
      const cnt = raw.prepare('SELECT COUNT(*) AS c FROM file_shares').get() as { c: number };
      raw.close();
      expect(Number(cnt.c)).toBe(0);
    });

    test('revoked share is not returned by lookup', () => {
      const m = mint();
      expect(store.revokeShare(m.shareId)).toBe(true);
      expect(store.lookupByToken(m.token)).toBeNull();
      expect(store.revokeShare('shr_missing')).toBe(false);
    });
  });

  describe('artifact registry binding (§8)', () => {
    test('artifact resolves ONLY in the owning agent AND session', () => {
      const id = store.registerArtifact({
        agentId: AGENT,
        sessionId: SESSION,
        relativePath: `${SESSION}/ok.png`,
        provider: 'codex-image',
        model: 'gpt-image',
        taskId: 't-1',
      });
      expect(id).toMatch(/^img_/);
      expect(store.resolveArtifact(AGENT, SESSION, id)?.relativePath).toBe(`${SESSION}/ok.png`);
      expect(store.resolveArtifact(AGENT, 'other-session', id)).toBeNull();
      expect(store.resolveArtifact('other-agent', SESSION, id)).toBeNull();
      expect(store.resolveArtifact(AGENT, SESSION, 'img_missing')).toBeNull();
    });

    // resolveArtifact must surface task_id — the hook a
    // resume-capable provider needs.
    test('resolveArtifact returns the taskId it was registered with', () => {
      const id = store.registerArtifact({
        agentId: AGENT,
        sessionId: SESSION,
        relativePath: `${SESSION}/resume.png`,
        provider: 'codex-image',
        model: 'gemini-image',
        taskId: 'task-xyz-123',
      });
      expect(store.resolveArtifact(AGENT, SESSION, id)?.taskId).toBe('task-xyz-123');
      expect(store.resolveArtifact(AGENT, SESSION, id)?.provider).toBe('codex-image');
    });

    // Handoff-on-model-switch: resolveArtifact must also
    // surface the prompt that produced the artifact — the deterministic reuse
    // source for continuing an edit across a model switch when resume isn't
    // possible.
    test('resolveArtifact returns the prompt it was registered with', () => {
      const id = store.registerArtifact({
        agentId: AGENT,
        sessionId: SESSION,
        relativePath: `${SESSION}/handoff.png`,
        provider: 'codex-image',
        model: 'gpt-image',
        prompt: 'a red cube on a white background',
      });
      expect(store.resolveArtifact(AGENT, SESSION, id)?.prompt).toBe('a red cube on a white background');
    });

    test('resolveArtifact returns an empty prompt (not undefined/null) when none was registered', () => {
      const id = store.registerArtifact({
        agentId: AGENT,
        sessionId: SESSION,
        relativePath: `${SESSION}/no-prompt.png`,
        provider: 'openai',
        model: 'gpt-image-1',
        // no prompt
      });
      expect(store.resolveArtifact(AGENT, SESSION, id)?.prompt).toBe('');
    });

    test('resolveArtifact returns an empty taskId (not undefined/null) when none was registered', () => {
      const id = store.registerArtifact({
        agentId: AGENT,
        sessionId: SESSION,
        relativePath: `${SESSION}/no-task.png`,
        provider: 'openai',
        model: 'gpt-image-1',
        // no taskId
      });
      expect(store.resolveArtifact(AGENT, SESSION, id)?.taskId).toBe('');
    });
  });

  describe('validateShareFile (§12)', () => {
    const validate = (ref: string, cap?: number) => validateShareFile(baseDir, AGENT, ref, cap);
    const codeOf = (fn: () => unknown): string => {
      try {
        fn();
      } catch (err) {
        if (err instanceof ShareError) return err.code;
        return `unexpected:${(err as Error).message}`;
      }
      return 'no-error';
    };

    test('accepts PNG/JPEG/WebP by relative path, media/-prefixed path and in-root absolute path', () => {
      fs.writeFileSync(path.join(mediaDir, 'ok.jpg'), JPEG);
      fs.writeFileSync(path.join(mediaDir, 'ok.webp'), WEBP);
      expect(validate(`${SESSION}/ok.png`).relativePath).toBe(`${SESSION}/ok.png`);
      expect(validate(`media/${SESSION}/ok.jpg`).mime).toBe('image/jpeg');
      expect(validate(path.join(mediaDir, 'ok.webp')).mime).toBe('image/webp');
    });

    test('rejects path traversal and absolute paths outside the media root', () => {
      const outside = path.join(baseDir, 'secret.png');
      fs.writeFileSync(outside, PNG);
      expect(codeOf(() => validate(`../../secret.png`))).toBe('invalid_path');
      expect(codeOf(() => validate(outside))).toBe('invalid_path');
      expect(codeOf(() => validate('/etc/hosts'))).toBe('invalid_path');
    });

    test('rejects a symlink escaping the media root', () => {
      const outside = path.join(baseDir, 'outside.png');
      fs.writeFileSync(outside, PNG);
      fs.symlinkSync(outside, path.join(mediaDir, 'sneaky.png'));
      expect(codeOf(() => validate(`${SESSION}/sneaky.png`))).toBe('invalid_path');
    });

    test('rejects directories (non-regular files)', () => {
      expect(codeOf(() => validate(SESSION))).toBe('invalid_path');
    });

    test('rejects unsupported magic bytes (txt, gif)', () => {
      fs.writeFileSync(path.join(mediaDir, 'note.txt'), 'hello world this is not an image');
      fs.writeFileSync(
        path.join(mediaDir, 'anim.gif'),
        Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(32, 4)]),
      );
      expect(codeOf(() => validate(`${SESSION}/note.txt`))).toBe('unsupported_file_type');
      expect(codeOf(() => validate(`${SESSION}/anim.gif`))).toBe('unsupported_file_type');
    });

    test('rejects a file over the per-file cap', () => {
      expect(codeOf(() => validate(`${SESSION}/ok.png`, 16))).toBe('file_too_large');
    });

    test('missing file → deterministic share_ref_not_found', () => {
      expect(codeOf(() => validate(`${SESSION}/gone.png`))).toBe('share_ref_not_found');
    });
  });

  describe('detectImageMime', () => {
    test('classifies phase-1 formats and rejects the rest', () => {
      expect(detectImageMime(PNG)).toBe('image/png');
      expect(detectImageMime(JPEG)).toBe('image/jpeg');
      expect(detectImageMime(WEBP)).toBe('image/webp');
      expect(detectImageMime(Buffer.from('GIF89a-not-allowed'))).toBeNull();
      expect(detectImageMime(Buffer.from('%PDF-1.4'))).toBeNull();
    });
  });

  // #444 — the wider share allowlist. detectImageMime stays image-only for the
  // callers that genuinely need an image (line_image, generate_image refs, the
  // session image catalog); detectShareMime is what the share bridge uses when
  // the caller opted into documents.
  describe('detectShareMime (#444)', () => {
    test('classifies the image formats AND PDF', () => {
      expect(detectShareMime(PNG)).toBe('image/png');
      expect(detectShareMime(JPEG)).toBe('image/jpeg');
      expect(detectShareMime(WEBP)).toBe('image/webp');
      expect(detectShareMime(PDF)).toBe('application/pdf');
    });

    test('still rejects everything off the allowlist — HTML/SVG are never shareable', () => {
      expect(detectShareMime(Buffer.from('GIF89a-not-allowed'))).toBeNull();
      expect(detectShareMime(Buffer.from('<!DOCTYPE html><html>'))).toBeNull();
      expect(detectShareMime(Buffer.from('<svg xmlns="http://'))).toBeNull();
      expect(detectShareMime(Buffer.from('plain text, no magic'))).toBeNull();
      // A near-miss on the PDF magic must not slip through.
      expect(detectShareMime(Buffer.from('%PDF+1.7'))).toBeNull();
      expect(detectShareMime(Buffer.from('%PDF'))).toBeNull();
    });
  });

  describe('document shares (#444)', () => {
    beforeEach(() => {
      fs.writeFileSync(path.join(mediaDir, 'doc.pdf'), PDF);
    });

    const codeOf = (fn: () => unknown): string => {
      try {
        fn();
      } catch (err) {
        if (err instanceof ShareError) return err.code;
        return `unexpected:${(err as Error).message}`;
      }
      return 'no-error';
    };

    test('validateShareFile rejects a PDF by default and accepts it with allow="any"', () => {
      expect(codeOf(() => validateShareFile(baseDir, AGENT, `${SESSION}/doc.pdf`))).toBe(
        'unsupported_file_type',
      );
      const ok = validateShareFile(baseDir, AGENT, `${SESSION}/doc.pdf`, undefined, 'any');
      expect(ok.mime).toBe('application/pdf');
      expect(ok.relativePath).toBe(`${SESSION}/doc.pdf`);
    });

    test('allow="any" does NOT relax anything else — containment, size and the allowlist still bite', () => {
      fs.writeFileSync(path.join(mediaDir, 'page.html'), '<!DOCTYPE html><html>x</html>');
      const outside = path.join(baseDir, 'outside.pdf');
      fs.writeFileSync(outside, PDF);
      fs.symlinkSync(outside, path.join(mediaDir, 'sneaky.pdf'));
      const any = (ref: string, cap?: number) => validateShareFile(baseDir, AGENT, ref, cap, 'any');

      expect(codeOf(() => any(`${SESSION}/page.html`))).toBe('unsupported_file_type');
      expect(codeOf(() => any('../../outside.pdf'))).toBe('invalid_path');
      expect(codeOf(() => any(`${SESSION}/sneaky.pdf`))).toBe('invalid_path');
      expect(codeOf(() => any(SESSION))).toBe('invalid_path');
      expect(codeOf(() => any(`${SESSION}/doc.pdf`, 16))).toBe('file_too_large');
      expect(codeOf(() => any(`${SESSION}/gone.pdf`))).toBe('share_ref_not_found');
    });

    test('the allow-kind is persisted per share and round-trips through lookup', () => {
      const img = mint();
      expect(store.lookupByToken(img.token)!.allowKind).toBe('image');

      const doc = mint({
        relativePath: `${SESSION}/doc.pdf`,
        dedupeRef: `path:${SESSION}/doc.pdf`,
        allowKind: 'any',
      });
      expect(store.lookupByToken(doc.token)!.allowKind).toBe('any');
    });

    test('two mints of the SAME ref under different allow-kinds do not collapse', () => {
      // They are different capabilities: one may serve a PDF, the other may not.
      const strict = mint();
      const wide = mint({ allowKind: 'any' });
      expect(wide.token).not.toBe(strict.token);
      expect(store.lookupByToken(strict.token)!.allowKind).toBe('image');
      expect(store.lookupByToken(wide.token)!.allowKind).toBe('any');
    });

    test('an unrecognised persisted allow_kind falls back to the STRICTEST kind', () => {
      const m = mint();
      const raw = new DatabaseSync(dbPath);
      raw.prepare('UPDATE file_shares SET allow_kind = ? WHERE id = ?').run('everything', m.shareId);
      raw.close();
      expect(store.lookupByToken(m.token)!.allowKind).toBe('image');
    });
  });

  // The `allow_kind` column is added in place, exactly like `prompt` on
  // image_artifacts: CREATE TABLE IF NOT EXISTS leaves an existing DB untouched.
  // The table itself is renamed image_shares -> file_shares, and that rename
  // MUST run before the CREATE TABLE IF NOT EXISTS, or the store would sit on an
  // empty new table and 404 every share minted before the upgrade.
  describe('migration from a pre-#444 database', () => {
    const seedLegacy = (legacyPath: string, token: string): void => {
      const legacy = new DatabaseSync(legacyPath);
      legacy.exec(`
        CREATE TABLE image_shares (
          id            TEXT PRIMARY KEY,
          token_hash    BLOB NOT NULL UNIQUE,
          agent_id      TEXT NOT NULL,
          session_id    TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          purpose       TEXT NOT NULL,
          created_at    INTEGER NOT NULL,
          expires_at    INTEGER NOT NULL,
          revoked_at    INTEGER
        );
        CREATE INDEX IF NOT EXISTS image_shares_expiry ON image_shares(expires_at);
      `);
      legacy
        .prepare(
          `INSERT INTO image_shares (id, token_hash, agent_id, session_id, relative_path, purpose, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'shr_legacy',
          createHash('sha256').update(token).digest(),
          AGENT,
          SESSION,
          `${SESSION}/ok.png`,
          'codex_ref',
          Date.now(),
          Date.now() + 600_000,
        );
      legacy.close();
    };

    test('an old DB opens, gains the column defaulted to image, and keeps its live shares', () => {
      const legacyPath = path.join(baseDir, 'legacy.db');
      const token = 'L'.repeat(32);
      seedLegacy(legacyPath, token);

      const migrated = new ShareStore(legacyPath);
      try {
        const row = migrated.lookupByToken(token);
        expect(row).not.toBeNull();
        expect(row!.shareId).toBe('shr_legacy');
        expect(row!.relativePath).toBe(`${SESSION}/ok.png`);
        expect(row!.allowKind).toBe('image');
      } finally {
        migrated.close();
      }

      // Opening it again is a no-op, not a duplicate-column error.
      const reopened = new ShareStore(legacyPath);
      try {
        expect(reopened.lookupByToken(token)!.allowKind).toBe('image');
      } finally {
        reopened.close();
      }
    });

    test('the table is RENAMED, not shadowed by an empty new one', () => {
      const legacyPath = path.join(baseDir, 'legacy-rename.db');
      const token = 'R'.repeat(32);
      seedLegacy(legacyPath, token);

      const migrated = new ShareStore(legacyPath);
      migrated.close();

      const raw = new DatabaseSync(legacyPath);
      try {
        const tables = (
          raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{ name: string }>
        ).map((r) => r.name);
        expect(tables).toContain('file_shares');
        expect(tables).not.toContain('image_shares');
        // The row survived the rename rather than being left behind.
        const cnt = raw.prepare('SELECT COUNT(*) AS c FROM file_shares').get() as { c: number };
        expect(cnt.c).toBe(1);
        // RENAME TO carries indexes over under their OLD names — the old one is
        // dropped so the new CREATE INDEX cannot leave a duplicate behind.
        const indexes = (
          raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'file_shares'`).all() as Array<{ name: string }>
        ).map((r) => r.name);
        expect(indexes).toContain('file_shares_expiry');
        expect(indexes).not.toContain('image_shares_expiry');
      } finally {
        raw.close();
      }
    });
  });
});
