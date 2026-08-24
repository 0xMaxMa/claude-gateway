/**
 * Bun tests for the shared-KB write mirror (memory_promote's building blocks).
 * Runs under Bun (`bun test`) alongside archive-reader.test.ts.
 */

import { test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { sharedNoteFilename, sharedNoteName, writeSharedNoteAtomic, triggerSharedReindex } from './archive-writer';
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

test('sharedNoteName: same agent/reason/content -> same name; different content -> different name', () => {
  const a = sharedNoteName('kaede-fua', 'deploy', 'the prod cluster runs on kubernetes');
  const b = sharedNoteName('kaede-fua', 'deploy', 'the prod cluster runs on kubernetes');
  const c = sharedNoteName('kaede-fua', 'deploy', 'a different fact entirely');
  expect(a).toBe(b);
  expect(a).not.toBe(c);
  expect(a.startsWith('kaede-fua-deploy-')).toBe(true);
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

test('writeSharedNoteAtomic: same content-hashed name overwrites in place (idempotent, no duplicate file)', () => {
  const vaultDir = tmpVaultDir();
  try {
    const name = sharedNoteName('agentA', 'oncall', 'escalate paging incidents to platform team');
    const p1 = writeSharedNoteAtomic(vaultDir, name, 'escalate paging incidents to platform team');
    const p2 = writeSharedNoteAtomic(vaultDir, name, 'escalate paging incidents to platform team');
    expect(p1).toBe(p2);
    expect(fs.readdirSync(path.join(vaultDir, 'notes')).length).toBe(1);
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test('triggerSharedReindex: never throws, even when the compiled CLI is missing', () => {
  const vaultDir = tmpVaultDir();
  try {
    expect(() => triggerSharedReindex(vaultDir)).not.toThrow();
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

// End-to-end proof of the acceptance criterion: a promoted note is discoverable
// via the same search path memory_search uses, WITHOUT waiting for the nightly
// dream or a manual reindex step. Uses the real compiled reindex-cli.js (built
// by `npm run build` into dist/ alongside this package, per package.json
// `files`) — skips gracefully if that build artifact is missing (e.g. a bare
// `bun test` run against source with no prior `npm run build`).
test('memory_promote flow: write + triggerSharedReindex makes the note searchable within a few seconds', async () => {
  const cliPath = path.join(__dirname, '..', '..', '..', 'dist', 'agent', 'knowledge', 'reindex-cli.js');
  if (!fs.existsSync(cliPath)) {
    console.warn('[archive-writer.test] dist/agent/knowledge/reindex-cli.js missing — run `npm run build` first; skipping e2e reindex test');
    return;
  }
  const vaultDir = tmpVaultDir();
  try {
    const content = 'The staging cluster now runs on kubernetes in ap-southeast-1.';
    const name = sharedNoteName('e2e-agent', 'infra-note', content);
    writeSharedNoteAtomic(vaultDir, name, content);
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
