/**
 * Tests for src/watch/factory.ts — shared chokidar watcher factory
 * WF1: add event fires onChange
 * WF2: change event fires onChange
 * WF3: unlink event fires onChange
 * WF4: rapid changes debounced to fewer calls
 * WF5: close() stops the watcher
 * WF6: onAddSync is called synchronously on add before debounce
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createWatcher } from '../../src/watch/factory';
import { waitFor } from '../helpers/wait-for';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('createWatcher', () => {
  test('WF1: fires onChange when a file is added', async () => {
    let count = 0;
    const handle = createWatcher({
      paths: [path.join(tmpDir, '*.md')],
      debounceMs: 50,
      onChange: () => { count++; },
    });

    await handle.ready;
    fs.writeFileSync(path.join(tmpDir, 'new.md'), 'hello');
    await waitFor(() => count >= 1, 5000);

    await handle.close();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('WF2: fires onChange when a file is modified', async () => {
    const filePath = path.join(tmpDir, 'existing.md');
    fs.writeFileSync(filePath, 'initial');

    let count = 0;
    const handle = createWatcher({
      paths: [filePath],
      debounceMs: 50,
      onChange: () => { count++; },
    });

    await handle.ready;
    fs.writeFileSync(filePath, 'updated');
    await waitFor(() => count >= 1, 5000);

    await handle.close();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('WF3: fires onChange when a file is deleted', async () => {
    const filePath = path.join(tmpDir, 'to-delete.md');
    fs.writeFileSync(filePath, 'bye');

    let count = 0;
    const handle = createWatcher({
      paths: [filePath],
      debounceMs: 50,
      onChange: () => { count++; },
    });

    await handle.ready;
    fs.rmSync(filePath);
    await waitFor(() => count >= 1, 5000);

    await handle.close();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('WF4: debounces rapid changes into fewer calls', async () => {
    let count = 0;
    const debounceMs = 200;
    const handle = createWatcher({
      paths: [path.join(tmpDir, '*.md')],
      debounceMs,
      onChange: () => { count++; },
    });

    await handle.ready;
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(tmpDir, `rapid-${i}.md`), 'x');
    }
    await waitFor(() => count >= 1, 5000);
    // Let the debounce window fully settle before asserting the upper bound —
    // scaled off the configured debounceMs rather than a hardcoded constant.
    await new Promise(r => setTimeout(r, debounceMs * 4));

    await handle.close();
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(3);
  });

  test('WF5: close() prevents further onChange calls', async () => {
    let count = 0;
    const handle = createWatcher({
      paths: [path.join(tmpDir, '*.md')],
      debounceMs: 50,
      onChange: () => { count++; },
    });

    await handle.ready;
    await handle.close();

    // Write after close — should NOT trigger onChange
    fs.writeFileSync(path.join(tmpDir, 'after-close.md'), 'x');
    await new Promise(r => setTimeout(r, 300));

    expect(count).toBe(0);
  });

  test('WF7: onChange receives the de-duplicated paths that changed in the window', async () => {
    const batches: string[][] = [];
    const handle = createWatcher({
      paths: [path.join(tmpDir, '*.md')],
      debounceMs: 200,
      onChange: (changed) => { batches.push(changed.map(p => path.basename(p))); },
    });

    await handle.ready;
    fs.writeFileSync(path.join(tmpDir, 'a.md'), 'x');
    fs.writeFileSync(path.join(tmpDir, 'b.md'), 'y');
    await waitFor(() => batches.length >= 1, 5000);

    await handle.close();
    expect(batches.length).toBeGreaterThanOrEqual(1);
    const all = batches.flat();
    expect(all).toContain('a.md');
    expect(all).toContain('b.md');
  });

  test('WF6: onAddSync is called synchronously on add with file path', async () => {
    const seen: string[] = [];
    const handle = createWatcher({
      paths: [path.join(tmpDir, '*.md')],
      debounceMs: 50,
      onAddSync: (fp) => { seen.push(path.basename(fp)); },
      onChange: () => {},
    });

    await handle.ready;
    fs.writeFileSync(path.join(tmpDir, 'hello.md'), 'x');
    await waitFor(() => seen.includes('hello.md'), 5000);

    await handle.close();
    expect(seen).toContain('hello.md');
  });
});
