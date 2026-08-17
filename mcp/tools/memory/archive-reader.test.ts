/**
 * Bun tests for the knowledge-archive read path (planning-64 K1).
 *
 * Runs under Bun (`bun test`) because the reader uses `bun:sqlite` — the Node
 * jest suite cannot load this module. The fixture DB is built with bun:sqlite
 * using the SAME schema src/ writes under node:sqlite (external-content FTS5 +
 * provenance/recall), so this exercises the real query path end to end.
 */

import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { searchArchive, getExcerpt, isMemoryScopedPath, archiveDbPath } from './archive-reader';

// Build a temp agent dir with a kb.sqlite carrying the given chunks.
function mkAgentWithArchive(
  chunks: Array<{ id: string; path: string; start: number; end: number; text: string; origin?: string; importance?: number }>,
): { agentDir: string; workspaceDir: string; dbPath: string } {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb1-'));
  const workspaceDir = path.join(agentDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const dbPath = archiveDbPath(workspaceDir); // agentDir/kb.sqlite

  const db = new Database(dbPath);
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(`
    CREATE TABLE kb_chunks (rowid_id INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, path TEXT,
      start_line INTEGER, end_line INTEGER, text TEXT, updated_at INTEGER);
    CREATE TABLE kb_chunk_recall (chunk_id TEXT PRIMARY KEY, importance INTEGER, triggers TEXT, project_key TEXT,
      FOREIGN KEY (chunk_id) REFERENCES kb_chunks(id) ON DELETE CASCADE);
    CREATE TABLE kb_chunk_provenance (chunk_id TEXT PRIMARY KEY, origin_class TEXT, session_kind TEXT,
      observed_at INTEGER, supersedes_key TEXT, FOREIGN KEY (chunk_id) REFERENCES kb_chunks(id) ON DELETE CASCADE);
    CREATE VIRTUAL TABLE kb_chunks_fts USING fts5(text, content='kb_chunks', content_rowid='rowid_id');
    CREATE TRIGGER kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
      INSERT INTO kb_chunks_fts(rowid, text) VALUES (new.rowid_id, new.text);
    END;
  `);
  const ins = db.prepare('INSERT INTO kb_chunks(id,path,start_line,end_line,text,updated_at) VALUES(?,?,?,?,?,?)');
  const insR = db.prepare('INSERT INTO kb_chunk_recall(chunk_id,importance) VALUES(?,?)');
  const insP = db.prepare('INSERT INTO kb_chunk_provenance(chunk_id,origin_class,session_kind,observed_at) VALUES(?,?,?,?)');
  for (const c of chunks) {
    ins.run(c.id, c.path, c.start, c.end, c.text, 1);
    insR.run(c.id, c.importance ?? null);
    insP.run(c.id, c.origin ?? 'agent', 'unknown', 1);
  }
  db.close();
  return { agentDir, workspaceDir, dbPath };
}

test('isMemoryScopedPath: accepts memory-scoped, rejects traversal/abs/out-of-scope', () => {
  expect(isMemoryScopedPath('MEMORY.md')).toBe(true);
  expect(isMemoryScopedPath('USER.md')).toBe(true);
  expect(isMemoryScopedPath('memory/foo.md')).toBe(true);
  expect(isMemoryScopedPath('memory/sub/bar.md')).toBe(true);
  expect(isMemoryScopedPath('../secret.md')).toBe(false);
  // The discriminating case: ends in .md AND starts with memory/, so ONLY the
  // ".." guard rejects it — proves that guard is load-bearing.
  expect(isMemoryScopedPath('memory/../secret.md')).toBe(false);
  expect(isMemoryScopedPath('memory/../../etc/passwd')).toBe(false);
  expect(isMemoryScopedPath('/etc/passwd')).toBe(false);
  expect(isMemoryScopedPath('notes/random.md')).toBe(false);
  expect(isMemoryScopedPath('AGENTS.md')).toBe(false);
});

test('searchArchive: FTS match returns ranked hit with provenance + importance', () => {
  const { workspaceDir, agentDir } = mkAgentWithArchive([
    { id: 'memory/getpod.md#1-1', path: 'memory/getpod.md', start: 1, end: 1, text: 'Getpod ingress returns 401 before the gateway', origin: 'agent', importance: 7 },
    { id: 'memory/apps.md#1-1', path: 'memory/apps.md', start: 1, end: 1, text: 'apps router mounts under gateway-router', origin: 'agent' },
  ]);
  try {
    const hits = searchArchive(archiveDbPath(workspaceDir), 'ingress 401', 6);
    expect(hits.length).toBe(1);
    expect(hits[0].path).toBe('memory/getpod.md');
    expect(hits[0].originClass).toBe('agent');
    expect(hits[0].importance).toBe(7);
    expect(hits[0].startLine).toBe(1);
    expect(typeof hits[0].score).toBe('number');
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test('searchArchive: missing DB → [], empty/punctuation query → []', () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb1-'));
  const workspaceDir = path.join(agentDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  try {
    expect(searchArchive(archiveDbPath(workspaceDir), 'anything', 6)).toEqual([]); // no kb.sqlite
    const { workspaceDir: ws2, agentDir: dir2 } = mkAgentWithArchive([
      { id: 'm#1-1', path: 'memory/a.md', start: 1, end: 1, text: 'hello world' },
    ]);
    expect(searchArchive(archiveDbPath(ws2), '   !!! ', 6)).toEqual([]); // no usable tokens
    fs.rmSync(dir2, { recursive: true, force: true });
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test('getExcerpt: bounded line range; out-of-scope/missing → null', () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb1-'));
  const workspaceDir = path.join(agentDir, 'workspace');
  fs.mkdirSync(path.join(workspaceDir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'memory/note.md'), 'l1\nl2\nl3\nl4\nl5');
  try {
    const ex = getExcerpt(workspaceDir, 'memory/note.md', 2, 2);
    expect(ex).not.toBeNull();
    expect(ex!.text).toBe('l2\nl3');
    expect(ex!.from).toBe(2);
    expect(ex!.to).toBe(3);
    expect(ex!.totalLines).toBe(5);
    expect(ex!.truncated).toBe(true);

    // Whole file → not truncated.
    expect(getExcerpt(workspaceDir, 'memory/note.md', 1, 100)!.truncated).toBe(false);
    // Out-of-scope path and missing file → null.
    expect(getExcerpt(workspaceDir, '../secret.md', 1, 5)).toBeNull();
    expect(getExcerpt(workspaceDir, 'memory/missing.md', 1, 5)).toBeNull();
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test('getExcerpt: a symlink inside memory/ escaping the workspace is refused', () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb1-'));
  const workspaceDir = path.join(agentDir, 'workspace');
  fs.mkdirSync(path.join(workspaceDir, 'memory'), { recursive: true });
  // A secret target OUTSIDE the workspace, and a memory/ symlink pointing at it.
  const secret = path.join(agentDir, 'outside-secret.md');
  fs.writeFileSync(secret, 'TOPSECRET outside the workspace');
  fs.symlinkSync(secret, path.join(workspaceDir, 'memory', 'evil.md'));
  try {
    // Passes the string scope check (memory/*.md) but realpath escapes the ws → null.
    expect(getExcerpt(workspaceDir, 'memory/evil.md', 1, 5)).toBeNull();
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});
