/**
 * Unit tests for config/config-write-lock.ts — the process-wide, per-path write
 * lock every config.json mutation now goes through.
 *
 * The serialisation tests are the contract the module exists for; the pruning
 * tests guard the bookkeeping underneath it, which must not cost a queued writer
 * its turn.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  withConfigWriteLock,
  lockedPathCountForTests,
  writeConfigAtomic,
} from '../../src/config/config-write-lock';

/** A path per test, so no two tests share a lock chain. */
function tmpConfigPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-lock-')), 'config.json');
}

/** Let every already-scheduled microtask (including the lock's own prune) run. */
const settle = () => new Promise((r) => setImmediate(r));

describe('withConfigWriteLock', () => {
  it('serialises two writers of the same path — the second starts only after the first returns', async () => {
    const p = tmpConfigPath();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((r) => {
      releaseFirst = r;
    });

    const a = withConfigWriteLock(p, async () => {
      order.push('a:start');
      await firstStarted;
      order.push('a:end');
    });
    const b = withConfigWriteLock(p, () => {
      order.push('b');
    });

    await settle();
    expect(order).toEqual(['a:start']); // b is queued, not running
    releaseFirst();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b']);
  });

  it('does not serialise writers of different paths', async () => {
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });

    const a = withConfigWriteLock(tmpConfigPath(), async () => {
      order.push('a:start');
      await held;
    });
    const b = withConfigWriteLock(tmpConfigPath(), () => {
      order.push('b');
    });

    await settle();
    expect(order).toEqual(['a:start', 'b']); // b did not wait on a
    release();
    await Promise.all([a, b]);
  });

  it('a rejecting writer does not poison the chain for the next one', async () => {
    const p = tmpConfigPath();
    const boom = withConfigWriteLock(p, () => {
      throw new Error('boom');
    });
    await expect(boom).rejects.toThrow('boom');
    await expect(withConfigWriteLock(p, () => 'ok')).resolves.toBe('ok');
  });

  it('keys on the resolved path, so two spellings of one file share a lock', async () => {
    const p = tmpConfigPath();
    const indirect = path.join(path.dirname(p), '.', 'config.json');
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });

    const a = withConfigWriteLock(p, async () => {
      order.push('a:start');
      await held;
      order.push('a:end');
    });
    const b = withConfigWriteLock(indirect, () => {
      order.push('b');
    });

    await settle();
    expect(order).toEqual(['a:start']);
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b']);
  });

  // A gateway writes one config.json for its whole life, so the map was never
  // going to grow there — but every test's temp config takes the same lock, and
  // each of those keys is a path nothing will write again.
  it('drops a path from the lock map once its last writer settles', async () => {
    const before = lockedPathCountForTests();
    await withConfigWriteLock(tmpConfigPath(), () => 'done');
    await settle();
    expect(lockedPathCountForTests()).toBe(before);
  });

  it('drops the path even when the writer rejected', async () => {
    const before = lockedPathCountForTests();
    await withConfigWriteLock(tmpConfigPath(), () => {
      throw new Error('boom');
    }).catch(() => {});
    await settle();
    expect(lockedPathCountForTests()).toBe(before);
  });

  // The one way pruning could break the lock: deleting the entry while a writer
  // is queued behind it would let the next arrival start a second, parallel
  // chain on the same file.
  it('does not drop a path that still has a queued writer — and that writer still runs last', async () => {
    const p = tmpConfigPath();
    const before = lockedPathCountForTests();
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });

    const a = withConfigWriteLock(p, async () => {
      order.push('a:start');
      await held;
      order.push('a:end');
    });
    const b = withConfigWriteLock(p, () => {
      order.push('b');
    });

    await settle();
    expect(lockedPathCountForTests()).toBe(before + 1);
    release();
    await Promise.all([a, b]);
    await settle();
    expect(order).toEqual(['a:start', 'a:end', 'b']);
    expect(lockedPathCountForTests()).toBe(before);
  });

  it('a writer arriving after the prune gets a working lock, not a lost turn', async () => {
    const p = tmpConfigPath();
    await withConfigWriteLock(p, () => 'first');
    await settle();
    await expect(withConfigWriteLock(p, () => 'second')).resolves.toBe('second');
  });
});

describe('writeConfigAtomic', () => {
  it('writes the file at 0600 and leaves no tmp file behind', async () => {
    const p = tmpConfigPath();
    await writeConfigAtomic(p, { gateway: { logDir: '/tmp' } });
    expect(JSON.parse(fs.readFileSync(p, 'utf-8'))).toEqual({ gateway: { logDir: '/tmp' } });
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(p))).toEqual(['config.json']);
  });
});
