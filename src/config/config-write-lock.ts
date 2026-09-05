import * as path from 'path';

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
  locks.set(key, run.catch(() => {}));
  return run;
}
