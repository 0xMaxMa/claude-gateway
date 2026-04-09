/**
 * Unit tests for MemoryManager
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MemoryManager } from '../../src/memory-manager';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mm-test-'));
}

describe('MemoryManager', () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(() => {
    tmpDir = createTempDir();
    manager = new MemoryManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── appendFact: existing section ─────────────────────────────────────────
  it('appendFact to existing section → fact appended under correct section', async () => {
    const memPath = path.join(tmpDir, 'MEMORY.md');
    fs.writeFileSync(memPath, '# Memory\n\n## User Facts\n- fact 1\n\n## Decisions\n- decision 1\n');

    await manager.appendFact('User Facts', 'Prefers dark mode');

    const content = fs.readFileSync(memPath, 'utf-8');
    // fact should be under User Facts, before Decisions
    const ufIdx = content.indexOf('## User Facts');
    const decIdx = content.indexOf('## Decisions');
    const darkModeIdx = content.indexOf('- Prefers dark mode');
    expect(darkModeIdx).toBeGreaterThan(ufIdx);
    expect(darkModeIdx).toBeLessThan(decIdx);
    expect(content).toContain('- fact 1');
    expect(content).toContain('- Prefers dark mode');
    expect(content).toContain('- decision 1');
  });

  // ─── appendFact: new section ───────────────────────────────────────────────
  it('appendFact to new section → section created + fact added', async () => {
    const memPath = path.join(tmpDir, 'MEMORY.md');
    fs.writeFileSync(memPath, '# Memory\n\n## User Facts\n- fact 1\n');

    await manager.appendFact('Preferences', 'No filler words');

    const content = fs.readFileSync(memPath, 'utf-8');
    expect(content).toContain('## Preferences');
    expect(content).toContain('- No filler words');
  });

  // ─── appendRaw ────────────────────────────────────────────────────────────
  it('appendRaw → raw markdown appended', async () => {
    await manager.appendRaw('\n## Custom\n- raw item\n');

    const content = await manager.readMemory();
    expect(content).toContain('## Custom');
    expect(content).toContain('- raw item');
  });

  // ─── readMemory ───────────────────────────────────────────────────────────
  it('readMemory → returns full content', async () => {
    const memPath = path.join(tmpDir, 'MEMORY.md');
    const expected = '# Memory\n\n## Test\n- item\n';
    fs.writeFileSync(memPath, expected);

    const content = await manager.readMemory();
    expect(content).toBe(expected);
  });

  it('readMemory → creates default file if not exists', async () => {
    const content = await manager.readMemory();
    expect(content).toContain('# Memory');
  });

  // ─── searchMemory ─────────────────────────────────────────────────────────
  it('searchMemory → returns matching lines only', async () => {
    const memPath = path.join(tmpDir, 'MEMORY.md');
    fs.writeFileSync(memPath, '# Memory\n\n## User Facts\n- dark mode\n- prefers coffee\n- dark theme\n');

    const results = await manager.searchMemory('dark');
    expect(results).toHaveLength(2);
    expect(results.every((l) => l.toLowerCase().includes('dark'))).toBe(true);
  });

  it('searchMemory → returns empty array when no matches', async () => {
    const memPath = path.join(tmpDir, 'MEMORY.md');
    fs.writeFileSync(memPath, '# Memory\n\n## Facts\n- hello world\n');

    const results = await manager.searchMemory('nonexistent-query-xyz');
    expect(results).toHaveLength(0);
  });

  // ─── getStats ─────────────────────────────────────────────────────────────
  it('getStats → correct sizeBytes, lineCount, sectionCount', async () => {
    const memPath = path.join(tmpDir, 'MEMORY.md');
    const content = '# Memory\n\n## User Facts\n- fact 1\n\n## Decisions\n- decision 1\n';
    fs.writeFileSync(memPath, content);

    const stats = await manager.getStats();
    expect(stats.sizeBytes).toBe(Buffer.byteLength(content, 'utf-8'));
    expect(stats.lineCount).toBe(content.split('\n').length);
    expect(stats.sectionCount).toBe(2);
  });

  // ─── trimToSize ───────────────────────────────────────────────────────────
  it('trimToSize → removes oldest lines, file under limit', async () => {
    const memPath = path.join(tmpDir, 'MEMORY.md');
    // Build a content > 100 chars
    const content =
      '# Memory\n\n## Facts\n- old fact 1\n- old fact 2\n- old fact 3\n- recent fact\n';
    fs.writeFileSync(memPath, content);

    const originalLength = content.length;
    expect(originalLength).toBeGreaterThan(50);

    const result = await manager.trimToSize(50);
    const newContent = fs.readFileSync(memPath, 'utf-8');

    expect(newContent.length).toBeLessThanOrEqual(50 + 5); // small tolerance for edge cases
    expect(result.removed).toBeGreaterThan(0);
  });

  it('trimToSize → does nothing if already under limit', async () => {
    const memPath = path.join(tmpDir, 'MEMORY.md');
    const content = '# Memory\n- short\n';
    fs.writeFileSync(memPath, content);

    const result = await manager.trimToSize(10000);
    expect(result.removed).toBe(0);
    expect(fs.readFileSync(memPath, 'utf-8')).toBe(content);
  });

  // ─── Thread-safety ────────────────────────────────────────────────────────
  it('Thread-safety: 10 concurrent appendFact calls → all 10 facts present', async () => {
    const facts = Array.from({ length: 10 }, (_, i) => `fact-${i}`);
    await Promise.all(facts.map((fact) => manager.appendFact('Concurrent', fact)));

    const content = await manager.readMemory();
    for (const fact of facts) {
      expect(content).toContain(`- ${fact}`);
    }
  });
});
