import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  resolveSharedConfig,
  SHARED_DEFAULTS,
  sharedVaultDir,
  sharedDbPath,
  sharedNotesDir,
  indexSharedArchive,
  writeSharedNote,
  sharedNoteFilename,
  ArchiveDB,
} from '../../src/agent/knowledge';
import type { ResolvedKnowledgeSharedCfg } from '../../src/agent/knowledge';

// A shared config rooted at a fresh temp dir so tests never touch the real vault.
function tmpSharedCfg(over: Partial<ResolvedKnowledgeSharedCfg> = {}): ResolvedKnowledgeSharedCfg {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-shared-'));
  return { ...SHARED_DEFAULTS, root, ...over };
}

describe('resolveSharedConfig', () => {
  test('defaults', () => {
    const r = resolveSharedConfig();
    expect(r.enabled).toBe(true);
    expect(r.project).toBe('global');
    expect(r.mode).toBe('propose');
    expect(r.root).toContain('.claude-gateway');
  });

  test('precedence agent > global > default; mode coerced', () => {
    const r = resolveSharedConfig({ project: 'teamA' }, { project: 'teamB', mode: 'auto' });
    expect(r.project).toBe('teamA'); // agent wins
    expect(r.mode).toBe('auto'); // global wins over default
    expect(resolveSharedConfig({ mode: 'nonsense' as 'auto' }).mode).toBe('propose'); // coerce
  });

  test('project key with traversal/separators is rejected → default "global"', () => {
    expect(resolveSharedConfig({ project: '../etc' }).project).toBe('global');
    expect(resolveSharedConfig({ project: 'a/b' }).project).toBe('global');
    expect(resolveSharedConfig({ project: 'ok-key_1.2' }).project).toBe('ok-key_1.2');
  });

  test('~ in root is expanded', () => {
    expect(resolveSharedConfig({ root: '~/x/kb' }).root).toBe(path.join(os.homedir(), 'x/kb'));
  });

  test('vault paths compose under <root>/<project>', () => {
    const cfg = resolveSharedConfig({ root: '/tmp/kbroot', project: 'proj1' });
    expect(sharedVaultDir(cfg)).toBe('/tmp/kbroot/proj1');
    expect(sharedDbPath(cfg)).toBe('/tmp/kbroot/proj1/kb.sqlite');
    expect(sharedNotesDir(cfg)).toBe('/tmp/kbroot/proj1/notes');
  });
});

describe('sharedNoteFilename', () => {
  test('slugifies, strips .md, contains to one segment', () => {
    expect(sharedNoteFilename('My Cool Note.md')).toBe('my-cool-note.md');
    expect(sharedNoteFilename('../../etc/passwd')).toBe('etc-passwd.md'); // no separators survive
    expect(sharedNoteFilename('')).toBe('note.md');
    expect(sharedNoteFilename('a/b\\c')).toBe('a-b-c.md');
  });
});

describe('writeSharedNote', () => {
  test('writes atomically into the notes dir and cannot escape it', () => {
    const cfg = tmpSharedCfg();
    try {
      const p = writeSharedNote(cfg, '../escape attempt', 'shared body');
      expect(p.startsWith(sharedNotesDir(cfg) + path.sep)).toBe(true); // contained
      expect(fs.readFileSync(p, 'utf8')).toBe('shared body');
      // No stray temp files left behind.
      expect(fs.readdirSync(sharedNotesDir(cfg)).some((f) => f.startsWith('.tmp-'))).toBe(false);
    } finally {
      fs.rmSync(cfg.root, { recursive: true, force: true });
    }
  });
});

describe('indexSharedArchive', () => {
  test('indexes shared notes with agent provenance + project key; searchable', () => {
    const cfg = tmpSharedCfg({ project: 'teamX' });
    try {
      writeSharedNote(cfg, 'deploy', 'The prod cluster runs on kubernetes in region eu-west.');
      writeSharedNote(cfg, 'oncall', 'Escalate paging incidents to the platform team first.');
      const res = indexSharedArchive(cfg, undefined);
      expect(res.filesIndexed).toBe(2);

      const db = ArchiveDB.forPath(sharedDbPath(cfg));
      const hits = db.search('kubernetes region');
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].path).toBe('deploy.md');
      const prov = db.getProvenance(hits[0].id)!;
      expect(prov.originClass).toBe('agent'); // shared = owner trust domain
      ArchiveDB.evict(sharedDbPath(cfg));
    } finally {
      fs.rmSync(cfg.root, { recursive: true, force: true });
    }
  });

  test('disabled → complete no-op (no DB)', () => {
    const cfg = tmpSharedCfg({ enabled: false });
    try {
      const res = indexSharedArchive(cfg, undefined);
      expect(res.filesIndexed).toBe(0);
      expect(fs.existsSync(sharedDbPath(cfg))).toBe(false);
    } finally {
      fs.rmSync(cfg.root, { recursive: true, force: true });
    }
  });

  test('hash-guarded reindex skips unchanged shared notes', () => {
    const cfg = tmpSharedCfg();
    try {
      writeSharedNote(cfg, 'a', 'alpha shared');
      expect(indexSharedArchive(cfg, undefined).filesIndexed).toBe(1);
      const second = indexSharedArchive(cfg, undefined);
      expect(second.filesIndexed).toBe(0);
      expect(second.filesSkipped).toBe(1);
      ArchiveDB.evict(sharedDbPath(cfg));
    } finally {
      fs.rmSync(cfg.root, { recursive: true, force: true });
    }
  });
});
