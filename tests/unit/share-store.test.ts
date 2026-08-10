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

const AGENT = 'a1';
const SESSION = 'session-1';

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
        .prepare('SELECT token_hash, id, agent_id, session_id, relative_path, purpose FROM image_shares')
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
      const cnt = raw.prepare('SELECT COUNT(*) AS c FROM image_shares').get() as { c: number };
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
      expect(codeOf(() => validate(`${SESSION}/note.txt`))).toBe('unsupported_image_type');
      expect(codeOf(() => validate(`${SESSION}/anim.gif`))).toBe('unsupported_image_type');
    });

    test('rejects a file over the per-file cap', () => {
      expect(codeOf(() => validate(`${SESSION}/ok.png`, 16))).toBe('image_too_large');
    });

    test('missing file → deterministic image_ref_not_found', () => {
      expect(codeOf(() => validate(`${SESSION}/gone.png`))).toBe('image_ref_not_found');
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
});
