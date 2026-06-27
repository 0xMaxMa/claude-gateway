import chokidar from 'chokidar';

export interface WatcherOptions {
  /** Glob patterns or file paths to watch */
  paths: string[];
  /** Debounce interval in ms */
  debounceMs: number;
  /** Additional chokidar options */
  chokidarOpts?: chokidar.WatchOptions;
  /**
   * Callback invoked (debounced) when any watched path changes.
   * Receives the de-duplicated list of file paths that changed during the
   * debounce window (empty-safe). Callers that don't care may ignore it.
   */
  onChange: (changedPaths: string[]) => void;
  /**
   * Optional synchronous side-effect called immediately on 'add' events,
   * before the debounced onChange fires (e.g. for file renames).
   */
  onAddSync?: (filePath: string) => void;
  /**
   * Optional handler for watcher-level errors (e.g. inotify ENOSPC). When
   * omitted, errors are logged and swallowed so a single failing watcher
   * never escalates to an unhandledRejection that crashes the whole gateway.
   */
  onError?: (err: NodeJS.ErrnoException) => void;
}

export interface WatchHandle {
  close(): Promise<void> | void;
  /** Resolves when chokidar has finished its initial scan and is ready to detect changes. */
  ready: Promise<void>;
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
  // Paths that changed during the current debounce window, flushed to onChange.
  let pendingPaths = new Set<string>();

  const debounced = (filePath?: string) => {
    if (filePath) pendingPaths.add(filePath);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const changed = Array.from(pendingPaths);
      pendingPaths = new Set();
      opts.onChange(changed);
    }, opts.debounceMs);
  };

  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });

  watcher
    .on('ready', resolveReady)
    .on('add', (filePath: string) => {
      if (opts.onAddSync) opts.onAddSync(filePath);
      debounced(filePath);
    })
    .on('change', (filePath: string) => debounced(filePath))
    .on('unlink', (filePath: string) => debounced(filePath))
    .on('error', (err: unknown) => {
      // chokidar surfaces watcher failures (e.g. inotify ENOSPC) via the
      // 'error' event. Without a listener these bubble up as an
      // unhandledRejection — which the gateway treats as fatal and exits on.
      // Catch, log actionably, and degrade this watcher instead of crashing.
      const e = err as NodeJS.ErrnoException;
      if (e && e.code === 'ENOSPC') {
        console.error(
          `[watch] inotify limit reached (ENOSPC) while watching ${opts.paths.join(', ')}; ` +
            'this watcher is degraded. Raise fs.inotify.max_user_instances / ' +
            'fs.inotify.max_user_watches, or reduce the number of watched paths.',
        );
      } else {
        console.error(`[watch] watcher error for ${opts.paths.join(', ')}:`, e?.message ?? e);
      }
      if (opts.onError) opts.onError(e);
    });

  return {
    ready,
    async close() {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      pendingPaths = new Set();
      await watcher.close();
    },
  };
}
