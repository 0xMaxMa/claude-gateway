import { createWatcher, WatchHandle } from '../watch/factory';

export interface SkillWatcherOptions {
  /** Directories to watch for SKILL.md changes */
  dirs: string[];
  /** Callback when skills change */
  onChange: () => void;
  /** Debounce interval in ms (default: 250) */
  debounceMs?: number;
}

/**
 * Watch skill directories for SKILL.md file changes (add/modify/delete).
 * Debounces rapid changes to avoid excessive rebuilds.
 * Returns a close() handle to stop watching.
 */
export function watchSkills(opts: SkillWatcherOptions): WatchHandle {
  const debounceMs = opts.debounceMs ?? 250;
  const validDirs = opts.dirs.filter(Boolean);

  if (validDirs.length === 0) {
    return { close: () => {} };
  }

  // Watch for SKILL.md files in skill subdirectories (depth 2)
  const patterns = validDirs.map((dir) => `${dir}/**/SKILL.md`);

  return createWatcher({
    paths: patterns,
    debounceMs,
    chokidarOpts: { depth: 2 },
    onChange: opts.onChange,
  });
}
