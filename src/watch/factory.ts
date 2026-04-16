import chokidar from 'chokidar';

export interface WatcherOptions {
  /** Glob patterns or file paths to watch */
  paths: string[];
  /** Debounce interval in ms */
  debounceMs: number;
  /** Additional chokidar options */
  chokidarOpts?: chokidar.WatchOptions;
  /** Callback invoked (debounced) when any watched path changes */
  onChange: () => void;
  /**
   * Optional synchronous side-effect called immediately on 'add' events,
   * before the debounced onChange fires (e.g. for file renames).
   */
  onAddSync?: (filePath: string) => void;
}

export interface WatchHandle {
  close(): Promise<void> | void;
}

/**
 * Shared chokidar watcher factory.
 * Watches the given paths, debounces rapid changes, and calls onChange.
 * Returns a WatchHandle with a close() method to stop watching.
 */
export function createWatcher(opts: WatcherOptions): WatchHandle {
  const watcher = chokidar.watch(opts.paths, {
    persistent: true,
    ignoreInitial: true,
    ...opts.chokidarOpts,
  });

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const debounced = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(opts.onChange, opts.debounceMs);
  };

  watcher
    .on('add', (filePath: string) => {
      if (opts.onAddSync) opts.onAddSync(filePath);
      debounced();
    })
    .on('change', debounced)
    .on('unlink', debounced);

  return {
    async close() {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      await watcher.close();
    },
  };
}
