/**
 * Tests for the error-handling path of src/watch/factory.ts.
 *
 * Regression guard: a watcher-level error (e.g. inotify ENOSPC) must NOT
 * escalate to an unhandledRejection — the gateway treats those as fatal and
 * calls process.exit(1), so one failing watcher used to take down every agent.
 * The factory attaches an 'error' listener that logs and degrades instead.
 *
 * chokidar is mocked here so 'error' can be emitted deterministically; the
 * integration-style tests in watch-factory.test.ts exercise the real module.
 */

import { EventEmitter } from 'events';

jest.mock('chokidar', () => {
  const { EventEmitter: EE } = require('events');
  const created: any[] = [];
  return {
    __esModule: true,
    default: {
      watch: jest.fn(() => {
        const ee: any = new EE();
        ee.close = jest.fn().mockResolvedValue(undefined);
        created.push(ee);
        return ee;
      }),
      __created: created,
    },
  };
});

import chokidar from 'chokidar';
import { createWatcher } from '../../src/watch/factory';

const watchMock = chokidar as unknown as {
  watch: jest.Mock;
  __created: EventEmitter[];
};

function lastWatcher(): any {
  const arr = watchMock.__created;
  return arr[arr.length - 1];
}

describe('createWatcher error handling', () => {
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    watchMock.watch.mockClear();
    watchMock.__created.length = 0;
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  test('WF-ERR1: ENOSPC error does not throw and is logged actionably', () => {
    createWatcher({
      paths: ['/some/path/*.md'],
      debounceMs: 50,
      onChange: () => {},
    });

    const enospc = Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    // Emitting 'error' with a registered listener must not throw / reject.
    expect(() => lastWatcher().emit('error', enospc)).not.toThrow();
    expect(errSpy).toHaveBeenCalled();
    const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('ENOSPC');
    expect(logged).toContain('max_user_instances');
  });

  test('WF-ERR2: onError callback receives the error', () => {
    const seen: NodeJS.ErrnoException[] = [];
    createWatcher({
      paths: ['/some/path'],
      debounceMs: 50,
      onChange: () => {},
      onError: (e) => seen.push(e),
    });

    const enospc = Object.assign(new Error('no space'), { code: 'ENOSPC' });
    lastWatcher().emit('error', enospc);

    expect(seen).toHaveLength(1);
    expect(seen[0].code).toBe('ENOSPC');
  });

  test('WF-ERR3: a non-ENOSPC error is also handled without throwing', () => {
    createWatcher({
      paths: ['/another/path'],
      debounceMs: 50,
      onChange: () => {},
    });

    const eperm = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    expect(() => lastWatcher().emit('error', eperm)).not.toThrow();
    expect(errSpy).toHaveBeenCalled();
  });

  test('WF-ERR4: an error listener is registered (prevents unhandled rejection)', () => {
    createWatcher({
      paths: ['/x'],
      debounceMs: 50,
      onChange: () => {},
    });
    // EventEmitter throws on emit('error') only when there is NO listener.
    // A registered listener is what converts a fatal crash into a logged warning.
    expect(lastWatcher().listenerCount('error')).toBeGreaterThanOrEqual(1);
  });
});
