import * as fs from 'fs';
import * as path from 'path';
import { explicitConfigWarning, listLogStreamIds, resolveLogDir } from '../logs-dir';
import { writeCommandHelp } from '../output';

/**
 * `gateway logs` — read the gateway's own logs without knowing where they live.
 *
 * The data was always well structured (one JSON object per line, written by
 * src/logger.ts); what was missing was any way to reach it from the CLI, so
 * operators had to know the on-disk layout and reach for `tail` by hand. A
 * `logs` command was in scope for #374 and dropped in #375 rather than shipped
 * as an always-failing stub; this is the version that works (#435).
 *
 * Every failure here is explicit — a missing directory, an unknown agent, a bad
 * `--lines` — because the one thing a log reader must never do is answer "no
 * logs" when the real answer is "I looked in the wrong place".
 */

/** Default tail length, matching what `tail` gives you for free minus the guesswork. */
const DEFAULT_LINES = 50;
/** Chunk size for the reverse read. */
const TAIL_CHUNK = 64 * 1024;
/** Ceiling on how much of a file the tail will scan backwards. A session log can
 *  be hundreds of MB; reading it whole to show 50 lines would be the same
 *  mistake `debug-bundle` exists to avoid. A tail that hits this stops early and
 *  returns what it has, which is still the newest content. */
const TAIL_MAX_SCAN = 8 * 1024 * 1024;
/** How often `--follow` re-stats the file. */
const DEFAULT_POLL_MS = 300;

interface LogRecord {
  ts?: unknown;
  level?: unknown;
  message?: unknown;
  data?: unknown;
}

/**
 * Render one stored line as `<ts> <level> <message>` with `data` appended
 * compactly.
 *
 * A line that is not a gateway log record is passed through verbatim rather
 * than dropped or replaced with a placeholder: anything already in the file is
 * something the operator may need to see, and a reader that silently discards
 * what it does not recognise is how a corrupt tail looks like an idle gateway.
 */
export function formatLogLine(line: string): string {
  let rec: LogRecord;
  try {
    rec = JSON.parse(line) as LogRecord;
  } catch {
    return line;
  }
  if (rec === null || typeof rec !== 'object' || typeof rec.message !== 'string') return line;
  const ts = typeof rec.ts === 'string' ? rec.ts : '-';
  const level = typeof rec.level === 'string' ? rec.level.toUpperCase().padEnd(5) : '-    ';
  const head = `${ts} ${level} ${rec.message}`;
  if (rec.data === undefined) return head;
  let data: string;
  try {
    data = JSON.stringify(rec.data);
  } catch {
    return head; // circular/unserialisable — the message alone is still useful
  }
  return `${head} ${data}`;
}

/**
 * The last `count` lines of `file`, oldest first, with the offset they were
 * read to.
 *
 * Reads backwards in chunks so the cost is bounded by what is asked for rather
 * than by the size of the file.
 *
 * `endPos` is what `--follow` must resume from. Following from a *later*
 * `statSync` would skip whatever the gateway appended in between: those bytes
 * are past the tail's read and before the follower's start, so nothing would
 * ever print them. Nothing can interleave here within this process — the read
 * is synchronous — but the writer is a different process, which is the whole
 * reason the command exists.
 */
export function tailFrom(file: string, count: number): { lines: string[]; endPos: number } {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let pos = size;
    let scanned = 0;
    let text = '';
    while (pos > 0 && scanned < TAIL_MAX_SCAN) {
      const len = Math.min(TAIL_CHUNK, pos);
      pos -= len;
      scanned += len;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      text = buf.toString('utf-8') + text;
      // +1 because the newline that ends the (count)th-from-last line belongs to
      // the line before it — stopping at `count` can return one line short.
      if (countNewlines(text) > count) break;
    }
    const lines = text.split('\n');
    // A leading fragment from a chunk boundary is not a whole line. It only
    // exists when the scan stopped short of the start of the file. Dropping it
    // is safe even when the boundary happens to land exactly on a newline: the
    // loop only stops with more than `count` lines in hand, so the one dropped
    // is always older than the newest `count`.
    if (pos > 0 && lines.length > 0) lines.shift();
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return { lines: lines.length > count ? lines.slice(lines.length - count) : lines, endPos: size };
  } finally {
    fs.closeSync(fd);
  }
}

/** The last `count` lines of `file`, oldest first. */
export function tailLines(file: string, count: number): string[] {
  return tailFrom(file, count).lines;
}

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

export interface LogsRunOptions {
  /** Stops `--follow`. Tests pass one; the CLI wires it to SIGINT. */
  signal?: AbortSignal;
  pollMs?: number;
}

/** Positive integer, or the reason it is not one. */
function parseLines(raw: string | boolean | undefined): { lines: number } | { error: string } {
  if (raw === undefined) return { lines: DEFAULT_LINES };
  if (typeof raw !== 'string') return { error: '--lines requires a value (a positive integer)' };
  if (!/^\d+$/.test(raw)) return { error: `--lines must be a positive integer, got "${raw}"` };
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) return { error: `--lines must be a positive integer, got "${raw}"` };
  return { lines: n };
}

function printHelp(requested: boolean): void {
  writeCommandHelp(
    requested,
    'gateway logs',
    'read the gateway log files on this host',
    'claude-gateway gateway logs [--follow] [--lines <n>] [--agent <id>] [--json] [--logDir <path>] [--config <path>]',
    [
      '  --follow         Stream new lines until interrupted (Ctrl-C)',
      `  --lines <n>      How many lines to show (default ${DEFAULT_LINES})`,
      '  --agent <id>     Read <id>.log instead of the process-wide gateway.log',
      '  --json           Print the stored lines verbatim, one JSON object per line',
      '  --logDir <path>  Read logs from here instead of the configured directory',
      '  --config <path>  Read logDir from this config file',
      '',
      '  Reads files directly, so it works even when the gateway is wedged or dead.',
    ],
  );
}

export async function runGatewayLogs(
  flags: Record<string, string | boolean>,
  opts: LogsRunOptions = {},
): Promise<number> {
  if (flags.help === true) {
    printHelp(true);
    return 0;
  }

  const parsed = parseLines(flags.lines);
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 1;
  }

  if (flags.agent !== undefined && typeof flags.agent !== 'string') {
    process.stderr.write('--agent requires a value (a log stream id)\n');
    return 1;
  }

  const logDir = resolveLogDir(flags);
  // Before anything else reads a path: if `--config` named a file we could not
  // use, say so now. Otherwise the "no log file at …" below names the default
  // directory and reads like an answer rather than a misdirection.
  const configWarning = explicitConfigWarning(flags);
  if (configWarning) process.stderr.write(`${configWarning}\n`);
  const streamId = typeof flags.agent === 'string' ? flags.agent : 'gateway';

  // A stream id reaches the filesystem, so it must not be able to leave the log
  // directory. Session streams legitimately contain ':' (`<agent>:session:<id>`),
  // so this rejects traversal rather than restricting the charset.
  if (streamId.includes('/') || streamId.includes('\\') || streamId.split(path.sep).includes('..')) {
    process.stderr.write(`Invalid --agent "${streamId}": a log stream id cannot contain a path separator\n`);
    return 1;
  }

  const file = path.join(logDir, `${streamId}.log`);
  if (!fs.existsSync(file)) {
    // Never "no logs found": say which path was tried, and — since an unknown
    // id is usually a typo — what could have been meant instead.
    const { ids, error } = listLogStreamIds(logDir);
    process.stderr.write(`No log file at ${file}\n`);
    if (error) {
      process.stderr.write(`${error}\n`);
    } else if (ids.length > 0) {
      process.stderr.write(`Available streams (--agent <id>): ${ids.join(', ')}\n`);
    } else {
      process.stderr.write(`${logDir} holds no log files yet\n`);
    }
    return 1;
  }

  const asJson = flags.json === true;
  const emit = (line: string): void => {
    if (line === '') return;
    process.stdout.write(`${asJson ? line : formatLogLine(line)}\n`);
  };

  let startPos: number;
  try {
    // Resume from where the tail stopped, not from a fresh stat: the gateway is
    // a different process and may have appended in between.
    const tail = tailFrom(file, parsed.lines);
    for (const line of tail.lines) emit(line);
    startPos = tail.endPos;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    process.stderr.write(`Cannot read ${file} (${e.code ?? e.message})\n`);
    return 1;
  }

  if (flags.follow !== true) return 0;
  return await followFile(file, startPos, emit, opts);
}

/**
 * Stream lines appended to `file` until aborted.
 *
 * Polls rather than using `fs.watch` because the file it is following can be
 * rotated out from under it (src/logger.ts renames `<name>.log` to
 * `<name>.log.1`): a watcher holds the old inode and would go quiet forever
 * while the gateway writes happily into the new file. Comparing the inode on
 * every poll turns that into a reopen.
 */
async function followFile(
  file: string,
  fromPos: number,
  emit: (line: string) => void,
  opts: LogsRunOptions,
): Promise<number> {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  let pos = fromPos;
  let inode: number | undefined;
  let carry = '';
  try {
    inode = fs.statSync(file).ino;
  } catch {
    /* the file was there a moment ago; treat it as rotated on the next poll */
  }

  const drain = (): void => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return; // mid-rotation: the rename has happened, the new file has not appeared
    }
    if (inode !== undefined && stat.ino !== inode) {
      // Rotated: a different file now answers to this name. Start at its
      // beginning — the bytes between the old position and the rotation are in
      // `<name>.log.1`, which the operator can read directly.
      inode = stat.ino;
      pos = 0;
      carry = '';
    } else if (stat.size < pos) {
      // Truncated in place (maxFiles = 0 unlinks rather than renames).
      pos = 0;
      carry = '';
    }
    if (inode === undefined) inode = stat.ino;
    if (stat.size <= pos) return;

    const len = stat.size - pos;
    const buf = Buffer.alloc(len);
    let read = 0;
    const fd = fs.openSync(file, 'r');
    try {
      read = fs.readSync(fd, buf, 0, len, pos);
    } finally {
      fs.closeSync(fd);
    }
    pos += read;
    // A tail can land mid-line; hold the fragment until its newline arrives so
    // a line is never emitted in two halves.
    const chunk = carry + buf.subarray(0, read).toString('utf-8');
    const parts = chunk.split('\n');
    carry = parts.pop() ?? '';
    for (const line of parts) emit(line);
  };

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      try {
        drain();
      } catch {
        /* transient (rotation race, permissions) — the next poll retries */
      }
    }, pollMs);
    // Deliberately NOT unref'ed. Elsewhere in this repo an interval is unref'ed
    // so a background timer cannot hold a process open at shutdown, but every
    // one of those runs inside the gateway server, which its HTTP listener
    // keeps alive regardless. This one runs in the CLI, where the interval is
    // the only ref'ed handle there is: `process.once('SIGINT')` does not hold
    // the loop open, so unref'ing here drained the loop and exited 0 the moment
    // the tail had been written — `--follow` printed the tail and returned
    // instead of following (#439). Nothing leaks: `stop()` clears the interval
    // on both the abort and the SIGINT path.
    const stop = (): void => {
      clearInterval(timer);
      resolve();
    };
    if (opts.signal) {
      if (opts.signal.aborted) return stop();
      opts.signal.addEventListener('abort', stop, { once: true });
    } else {
      process.once('SIGINT', stop);
    }
  });
  // One last pass so lines written between the final poll and the interrupt are
  // not lost, then flush any line the file never terminated.
  try {
    drain();
  } catch {
    /* best-effort */
  }
  if (carry !== '') emit(carry);
  return 0;
}
