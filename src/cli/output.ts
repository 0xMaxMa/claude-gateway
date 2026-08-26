/**
 * stdout is the CLI's result channel and carries JSON only — help, prompts,
 * progress and errors all go to stderr, so a caller can pipe stdout straight
 * into `jq` from any command.
 *
 * `compact` (the global `--json` flag) prints one minified line for scripts;
 * the default is pretty-printed for humans. Either way the output is valid
 * JSON. Shared so every command formats its result identically.
 */

import { paletteFor } from './colors';
export function printResult(data: unknown, compact: boolean): void {
  if (typeof data === 'string') {
    process.stdout.write(data + '\n');
    return;
  }
  process.stdout.write((compact ? JSON.stringify(data) : JSON.stringify(data, null, 2)) + '\n');
}

/** `printResult` driven straight from a parsed flag bag. */
export function printJson(data: unknown, flags: Record<string, string | boolean>): void {
  printResult(data, flags.json === true);
}

/**
 * Wait for stdout/stderr to reach the OS, then exit with `code`.
 *
 * When stdout is a pipe Node's writes are asynchronous, so `process.exit()`
 * discards whatever is still buffered — a large `--json` payload piped into
 * `jq` arrives truncated at the pipe buffer (64 KiB on Linux) and the pipeline
 * fails on invalid JSON. Draining first is what makes `printResult` safe to
 * pipe from any command.
 *
 * `process.exitCode` alone is not enough: a stray handle (an interval, a
 * lingering socket) would keep the CLI alive after its output is done, so the
 * exit is still explicit. `timeoutMs` bounds the wait — a reader that goes
 * away mid-write must not hang the CLI.
 */
export async function exitAfterFlush(code: number, timeoutMs = 2000): Promise<never> {
  process.exitCode = code;
  const drain = (s: NodeJS.WriteStream): Promise<void> =>
    new Promise<void>((resolve) => {
      if (s.writableLength === 0 || s.destroyed || s.writableEnded) {
        resolve();
        return;
      }
      // An empty write's callback runs after every pending chunk has flushed.
      s.write('', () => resolve());
      s.once('error', () => resolve());
    });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([Promise.all([drain(process.stdout), drain(process.stderr)]), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  process.exit(code);
}

/**
 * Where a help listing goes.
 *
 * An explicitly requested `--help` exits 0: it *is* the command's result, so it
 * belongs on stdout, where it can be paged, grepped or redirected like any
 * other output. The same listing printed because the invocation was wrong is
 * diagnostic and stays on stderr, so stdout still carries results only. Both
 * cases previously went to stderr, which left `claude-gateway --help | less`
 * showing an empty screen.
 */
export function helpStream(requested: boolean): NodeJS.WriteStream {
  return requested ? process.stdout : process.stderr;
}

/**
 * The shared shape of a command's help: a bold `claude-gateway <command>`
 * banner naming what it does, then its usage line, then anything specific.
 *
 * Every command renders through this so the surface reads as one program —
 * `doctor` and `agents` grew a banner while `gateway` and `update` printed a
 * bare `Usage:` line, which is the kind of drift a shared renderer prevents.
 * The brand tone stays reserved for the general help banner.
 */
export function writeCommandHelp(
  requested: boolean,
  command: string,
  summary: string,
  usage: string,
  extra: string[] = [],
): void {
  const stream = helpStream(requested);
  const c = paletteFor(stream);
  const lines = [
    `${c.bold(`claude-gateway ${command}`)} — ${summary}`,
    '',
    `${c.bold('Usage:')} ${usage}`,
    ...(extra.length ? ['', ...extra] : []),
  ];
  stream.write(lines.join('\n') + '\n');
}
