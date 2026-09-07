import * as path from 'path';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import { randomUUID } from 'crypto';

/**
 * One process-wide write lock per config.json path.
 *
 * config.json is mutated by several unrelated subsystems — the agents API
 * (api/router.ts), a model change from a chat command (agent/runner.ts), app-agent
 * install/uninstall (apps/agent-manager.ts), and connector management
 * (connectors/custom-connectors-store.ts). Each of those did its own
 * read → parse → mutate → write-tmp → rename, and each guarded it with a `Promise`
 * chain private to its own module or instance.
 *
 * Private locks only serialise a writer against itself. Two different writers still
 * interleave: both read the same bytes, each applies its own mutation to its own copy,
 * and the second rename discards the first one's change — a connector the admin just
 * added, or a model the user just switched to, silently gone with no error anywhere.
 * Whole-file rename means there is no partial-write corruption to detect, either; the
 * losing change simply never existed.
 *
 * Keying on the resolved path (rather than a single global) keeps tests that point at
 * their own temp config from serialising against each other, and is what makes this
 * safe to adopt everywhere: a writer that holds the lock for a slow operation only
 * blocks other writers of the same file.
 *
 * This is a process-local lock. It does not coordinate with a second gateway process
 * writing the same file — that has never been a supported deployment, and an advisory
 * file lock would be the fix if it ever were.
 */
const locks = new Map<string, Promise<unknown>>();

export function withConfigWriteLock<T>(
  configPath: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const key = path.resolve(configPath);
  const prev = locks.get(key) ?? Promise.resolve();
  // `.catch` so one caller's rejection doesn't poison the chain for the next.
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  // Dropped once this is the last writer for the path, because the map is
  // otherwise append-only and keyed on a string this module does not choose. A
  // gateway writes one config.json for its whole life, so this is not the leak
  // it would be elsewhere — but the same lock is what every test's temp config
  // goes through, and each of those keys is a path that will never be written
  // again. `locks.get(key) === tail` is the whole safety condition: a writer
  // that chained on while this one ran has already replaced the tail, so the
  // delete does not run and its turn is not lost. One that arrives after the
  // delete finds no entry and starts a fresh chain, which is correct — the
  // chain it would have joined had already settled.
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}

/** How many paths currently have a live lock chain. Exported for the tests that
 *  assert the map above is pruned rather than append-only; nothing in `src`
 *  reads it. */
export function lockedPathCountForTests(): number {
  return locks.size;
}

/**
 * The write half of every config.json mutation: serialise, write to a fresh tmp
 * path, rename over the target.
 *
 * `mode: 0o600` is the part that has to be got right every time and had been
 * copy-pasted five ways. config.json carries the admin API key and every agent's
 * channel bot tokens, and `rename()` carries the tmp file's mode onto the
 * destination — so a tmp file written at the default 0644 silently downgrades an
 * existing 0600 config on its first edit (issue #460). Centralised here so a sixth
 * writer inherits the policy instead of re-deriving it, and so the fix for the next
 * thing found wrong with it lands in one place.
 *
 * The `randomUUID()` suffix is load-bearing, not cosmetic: `writeFile`'s `mode` is
 * only applied when it CREATES the file, so a fixed tmp path left behind by a
 * crashed write is reused at whatever mode it already had, and the 0600 never
 * lands. A unique path per write cannot collide with a stale leftover, which is why
 * this needs no follow-up `chmod` — the call sites that used a fixed `.tmp` or a
 * pid-suffixed one did.
 *
 * Callers are expected to already hold `withConfigWriteLock` for `configPath` —
 * this function does not take it, because the read-parse-mutate that precedes it
 * has to be inside the same critical section to be worth anything.
 *
 * A failed `rename` leaves the tmp file behind, and the uniqueness that makes the
 * 0600 reliable is exactly what stops a later write from reusing (and thereby
 * clearing) it: every leak is permanent, and each one is a full plaintext copy of
 * config.json — admin API key, every agent's bot tokens — accumulating next to the
 * real file. Unlinked best-effort on the way out, matching connectors/token-env.ts.
 * The unlink's own failure is swallowed: the caller's error is the one worth
 * raising, and a tmp file that cannot be removed is not made better by hiding why
 * the write failed.
 */
export async function writeConfigAtomic(configPath: string, config: unknown): Promise<void> {
  const tmp = `${configPath}.tmp.${randomUUID()}`;
  await fsp.writeFile(tmp, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
  try {
    await fsp.rename(tmp, configPath);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

/** `writeConfigAtomic` for the two callers that run inside a synchronous critical
 *  section (agent/runner.ts's model persist, apps/agent-manager.ts's writeConfig)
 *  and cannot await without letting another writer interleave. Same tmp/mode/rename
 *  policy, and the same best-effort cleanup on a failed rename — kept beside it so
 *  the two can never drift apart. */
export function writeConfigAtomicSync(configPath: string, config: unknown): void {
  const tmp = `${configPath}.tmp.${randomUUID()}`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
  try {
    fs.renameSync(tmp, configPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort — the rename error below is the one that matters */
    }
    throw err;
  }
}
