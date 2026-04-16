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

    await new Promise(r => setTimeout(r, 150));
    fs.writeFileSync(path.join(tmpDir, 'new.md'), 'hello');
    await new Promise(r => setTimeout(r, 300));

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

    await new Promise(r => setTimeout(r, 150));
    fs.writeFileSync(filePath, 'updated');
    await new Promise(r => setTimeout(r, 300));

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

    await new Promise(r => setTimeout(r, 150));
    fs.rmSync(filePath);
    await new Promise(r => setTimeout(r, 300));

    await handle.close();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('WF4: debounces rapid changes into fewer calls', async () => {
    let count = 0;
    const handle = createWatcher({
      paths: [path.join(tmpDir, '*.md')],
      debounceMs: 200,
      onChange: () => { count++; },
    });

    await new Promise(r => setTimeout(r, 150));
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(tmpDir, `rapid-${i}.md`), 'x');
    }
    await new Promise(r => setTimeout(r, 800));

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

    await new Promise(r => setTimeout(r, 150));
    await handle.close();

    // Write after close — should NOT trigger onChange
    fs.writeFileSync(path.join(tmpDir, 'after-close.md'), 'x');
    await new Promise(r => setTimeout(r, 300));

    expect(count).toBe(0);
  });

  test('WF6: onAddSync is called synchronously on add with file path', async () => {
    const seen: string[] = [];
    const handle = createWatcher({
      paths: [path.join(tmpDir, '*.md')],
      debounceMs: 50,
      onAddSync: (fp) => { seen.push(path.basename(fp)); },
      onChange: () => {},
    });

    await new Promise(r => setTimeout(r, 150));
    fs.writeFileSync(path.join(tmpDir, 'hello.md'), 'x');
    await new Promise(r => setTimeout(r, 300));

    await handle.close();
    expect(seen).toContain('hello.md');
  });
});
