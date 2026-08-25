/**
 * Bun tests for the shared-KB write mirror (memory_shared_create/_get/_update/
 * _delete's building blocks). Runs under Bun (`bun test`) alongside archive-reader.test.ts.
 */

import { test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  sharedNoteFilename,
  sharedNoteExists,
  readSharedNote,
  writeSharedNoteAtomic,
  deleteSharedNote,
  contentLossPercent,
  triggerSharedReindex,
} from './archive-writer';
import { searchArchive } from './archive-reader';

function tmpVaultDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kb-shared-write-'));
}

test('sharedNoteFilename: slugifies, strips .md, contains to one segment (mirrors Node-side shared-writer)', () => {
  expect(sharedNoteFilename('My Cool Note.md')).toBe('my-cool-note.md');
  expect(sharedNoteFilename('../../etc/passwd')).toBe('etc-passwd.md'); // no separators survive
  expect(sharedNoteFilename('')).toBe('note.md');
  expect(sharedNoteFilename('a/b\\c')).toBe('a-b-c.md');
});

test('writeSharedNoteAtomic: writes atomically into <vaultDir>/notes and cannot escape it', () => {
  const vaultDir = tmpVaultDir();
  try {
    const p = writeSharedNoteAtomic(vaultDir, '../escape attempt', 'shared body');
    const notesDir = path.join(vaultDir, 'notes');
    expect(p.startsWith(notesDir + path.sep)).toBe(true); // contained
    expect(fs.readFileSync(p, 'utf8')).toBe('shared body');
    // No stray temp files left behind.
    expect(fs.readdirSync(notesDir).some((f) => f.startsWith('.tmp-'))).toBe(false);
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test('sharedNoteExists: false before write, true after — the basis for memory_shared_create/_update\'s existence gates', () => {
  const vaultDir = tmpVaultDir();
  try {
    expect(sharedNoteExists(vaultDir, 'oncall')).toBe(false);
    writeSharedNoteAtomic(vaultDir, 'oncall', 'escalate paging incidents to platform team');
    expect(sharedNoteExists(vaultDir, 'oncall')).toBe(true);
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test('readSharedNote: null before write, full content after', () => {
  const vaultDir = tmpVaultDir();
  try {
    expect(readSharedNote(vaultDir, 'oncall')).toBeNull();
    writeSharedNoteAtomic(vaultDir, 'oncall', 'escalate paging incidents to platform team');
    expect(readSharedNote(vaultDir, 'oncall')).toBe('escalate paging incidents to platform team');
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test('writeSharedNoteAtomic: same name overwrites in place (update semantics, no duplicate file)', () => {
  const vaultDir = tmpVaultDir();
  try {
    const p1 = writeSharedNoteAtomic(vaultDir, 'oncall', 'v1: escalate to platform team');
    const p2 = writeSharedNoteAtomic(vaultDir, 'oncall', 'v2: escalate to SRE team');
    expect(p1).toBe(p2);
    expect(fs.readFileSync(p2, 'utf8')).toBe('v2: escalate to SRE team');
    expect(fs.readdirSync(path.join(vaultDir, 'notes')).length).toBe(1);
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test('deleteSharedNote: removes an existing note and reports true; false (no-op) if absent', () => {
  const vaultDir = tmpVaultDir();
  try {
    expect(deleteSharedNote(vaultDir, 'oncall')).toBe(false); // nothing written yet
    writeSharedNoteAtomic(vaultDir, 'oncall', 'escalate paging incidents to platform team');
    expect(sharedNoteExists(vaultDir, 'oncall')).toBe(true);
    expect(deleteSharedNote(vaultDir, 'oncall')).toBe(true);
    expect(sharedNoteExists(vaultDir, 'oncall')).toBe(false);
    expect(deleteSharedNote(vaultDir, 'oncall')).toBe(false); // already gone
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test('deleteSharedNote: cannot escape the notes dir (name is filename-slugified first)', () => {
  const vaultDir = tmpVaultDir();
  try {
    // Nothing outside notes/ can ever be targeted, so this is always a no-op.
    expect(deleteSharedNote(vaultDir, '../../etc/passwd')).toBe(false);
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test('contentLossPercent: 0 when every old line survives, 100 when none do', () => {
  const oldContent = 'line one\nline two\nline three';
  expect(contentLossPercent(oldContent, 'line one\nline two\nline three\nline four')).toBe(0); // pure append, nothing dropped
  expect(contentLossPercent(oldContent, 'totally different content')).toBe(100);
});

test('contentLossPercent: dropping a subset of old lines is proportional loss, not zero', () => {
  const oldContent = 'line one\nline two\nline three';
  expect(contentLossPercent(oldContent, 'line one\nline two')).toBe(33); // 1 of 3 old lines missing
});

test('contentLossPercent: partial loss rounds to nearest percent', () => {
  // 2 of 4 old lines survive verbatim -> 50% lost.
  const oldContent = 'a\nb\nc\nd';
  expect(contentLossPercent(oldContent, 'a\nb\nsomething else')).toBe(50);
});

test('contentLossPercent: empty old content never divides by zero', () => {
  expect(contentLossPercent('', 'brand new content')).toBe(0);
  expect(contentLossPercent('\n\n', 'brand new content')).toBe(0); // blank-only old content
});

test('triggerSharedReindex: never throws, even when the compiled CLI is missing', () => {
  const vaultDir = tmpVaultDir();
  try {
    expect(() => triggerSharedReindex(vaultDir)).not.toThrow();
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

// End-to-end proof of the acceptance criterion: a written note is discoverable
// via the same search path memory_search uses, WITHOUT waiting for the nightly
// dream or a manual reindex step. Uses the real compiled reindex-cli.js (built
// by `npm run build` into dist/ alongside this package, per package.json
// `files`) — skips gracefully if that build artifact is missing (e.g. a bare
// `bun test` run against source with no prior `npm run build`).
test('memory_shared_create flow: write + triggerSharedReindex makes the note searchable within a few seconds', async () => {
  const cliPath = path.join(__dirname, '..', '..', '..', 'dist', 'agent', 'knowledge', 'reindex-cli.js');
  if (!fs.existsSync(cliPath)) {
    console.warn('[archive-writer.test] dist/agent/knowledge/reindex-cli.js missing — run `npm run build` first; skipping e2e reindex test');
    return;
  }
  const vaultDir = tmpVaultDir();
  try {
    const content = 'The staging cluster now runs on kubernetes in ap-southeast-1.';
    writeSharedNoteAtomic(vaultDir, 'infra-note', content);
    triggerSharedReindex(vaultDir);

    const dbPath = path.join(vaultDir, 'kb.sqlite');
    const deadline = Date.now() + 8000;
    let hits: ReturnType<typeof searchArchive> = [];
    while (Date.now() < deadline) {
      hits = searchArchive(dbPath, 'staging cluster kubernetes', 5);
      if (hits.length > 0) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].snippet).toContain('kubernetes');
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
}, 12000);
