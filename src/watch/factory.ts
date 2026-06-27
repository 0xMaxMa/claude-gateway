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
 * A degraded watcher recorded for health reporting. One entry per distinct
 * (error code, watched paths) pair; repeated errors increment `count` rather
 * than piling up. Surfaced on GET /status so an ENOSPC degrade is observable
 * in production instead of being a single console line nobody sees.
 */
export interface WatcherErrorRecord {
  paths: string[];
  code: string | null;
  message: string;
  count: number;
  firstAt: string; // ISO-8601
  lastAt: string; // ISO-8601
}

// Bounded by the number of distinct watchers (a few dozen at most), so this
// never grows unbounded. Keyed by `${code}:${paths}`.
const watcherErrors = new Map<string, WatcherErrorRecord>();

/** Snapshot of degraded watchers for health reporting. Empty when healthy. */
export function getWatcherHealth(): WatcherErrorRecord[] {
  return [...watcherErrors.values()].map((r) => ({ ...r, paths: [...r.paths] }));
}

/** Test-only: clear the recorded watcher-error registry. */
export function resetWatcherHealth(): void {
  watcherErrors.clear();
}

function recordWatcherError(paths: string[], e: NodeJS.ErrnoException): void {
  const code = e?.code ?? null;
  const key = `${code ?? 'ERR'}:${paths.join(',')}`;
  const now = new Date().toISOString();
  const existing = watcherErrors.get(key);
  if (existing) {
    existing.count += 1;
    existing.lastAt = now;
    existing.message = e?.message ?? String(e);
  } else {
    watcherErrors.set(key, {
      paths: [...paths],
      code,
      message: e?.message ?? String(e),
      count: 1,
      firstAt: now,
      lastAt: now,
    });
  }
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
      // Record for /status health reporting so the degrade is observable in
      // production, not just a single console line.
      recordWatcherError(opts.paths, e);
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
