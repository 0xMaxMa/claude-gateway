/**
 * Guards the two habits that produced the flaky suites this file was added
 * alongside. Both are checkable from the test sources themselves, which is the
 * only place they can be caught — a test that sleeps instead of waiting for a
 * signal passes on an idle machine and fails on a busy one, so no amount of
 * running the suite proves it absent.
 *
 * 1. A watcher created without awaiting its `ready` promise. chokidar runs with
 *    `ignoreInitial: true`, so a write landing before its initial scan finishes
 *    emits NOTHING — the test then waits out its whole deadline for an event
 *    that will never arrive. `createWatcher()` returns a `ready` promise for
 *    exactly this reason; sleeping "long enough" instead is a bet on machine
 *    speed.
 *
 * 2. A locally redefined poller. Eleven of them existed — nine named `waitFor`
 *    (eight suites plus the PTY harness) and two named `waitForCondition` —
 *    with timeouts drifted to 3000 / 4000 / 5000 / 10000ms, eleven independent
 *    guesses at how fast the machine is. They now share
 *    tests/helpers/wait-for.ts.
 */

import * as fs from 'fs';
import * as path from 'path';

const TEST_ROOT = path.resolve(__dirname, '..');

function testSources(): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.test.ts')) {
        out.push({ rel: path.relative(TEST_ROOT, full), text: fs.readFileSync(full, 'utf8') });
      }
    }
  };
  walk(TEST_ROOT);
  return out;
}

describe('test timing hygiene', () => {
  // Suites that mock chokidar outright drive the 'error'/'add' events by hand,
  // so there is no real initial scan to wait for.
  const MOCKS_CHOKIDAR = (text: string): boolean => /jest\.mock\(['"]chokidar['"]/.test(text);

  const CREATES_WATCHER = /\b(?:createWatcher|watchWorkspace|watchSkills)\s*\(/;

  it('every suite that starts a real watcher awaits its ready promise', () => {
    const offenders = testSources()
      .filter(({ text }) => CREATES_WATCHER.test(text) && !MOCKS_CHOKIDAR(text))
      .filter(({ text }) => !/\.ready\b/.test(text))
      .map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });

  it('no suite redefines a local waitFor poller', () => {
    const offenders = testSources()
      .filter(({ rel }) => !rel.startsWith('helpers'))
      .filter(({ text }) => /\b(?:async\s+)?function\s+waitFor(?:Condition)?\s*\(/.test(text))
      .map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });
});
