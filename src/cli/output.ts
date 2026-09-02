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
 * Resolve once everything already written to `s` has reached the OS — or has
 * failed and been reported.
 *
 * Two separate things outlive the `write()` call that started them, and a
 * caller that waits for either has to wait for both:
 *
 *  - **Buffering.** Into a pipe, `write()` returns as soon as the chunk is
 *    queued. An empty write's callback runs after every chunk ahead of it has
 *    flushed — or with the failure that stopped it — which is what makes this
 *    both a drain and a report.
 *  - **Reporting.** A failed write is reported *after* the call that made it
 *    returns, so a stream with nothing left buffered can still owe its caller an
 *    error. That is not merely untidy: the caller decides an exit code on it,
 *    and a caller that detaches its own `'error'` listener before the event
 *    lands leaves it unhandled, which ends the process.
 *
 * Awaiting this is enough for the second case without any extra delay here.
 * Measured on this platform (EPIPE on a closed pipe, ENOSPC on a full device,
 * both file and socket stdout): the failure is queued for delivery during the
 * write itself, and the tick queue that carries it runs ahead of the microtask
 * that resumes the `await`. So by the time a caller has this promise's value it
 * has already seen the error.
 *
 * The empty write is skipped when nothing is buffered, and that is not an
 * economy. A stream that has already failed fails the extra write too, and that
 * second failure is reported after this promise has settled and the listeners —
 * the caller's and the one below — are gone: `gateway logs --follow | head -5`
 * ended in an uncaught `write EPIPE` with the drain removed. Nothing can be in
 * flight on a stream with an empty buffer anyway. `destroyed`/`writableEnded`
 * is guarded for a different reason: writing to a finished stream emits
 * ERR_STREAM_WRITE_AFTER_END, an error the caller never had coming.
 */
export function flushStream(s: NodeJS.WriteStream): Promise<void> {
  return new Promise<void>((resolve) => {
    const settle = (): void => {
      s.off('error', settle);
      resolve();
    };
    if (s.writableLength === 0 || s.destroyed || s.writableEnded) {
      settle();
      return;
    }
    // Backstop: a failure that never reached the write callback would otherwise
    // leave this pending forever, and `runGatewayLogs` has no deadline of its
    // own. No test distinguishes it — every failure measured here does reach the
    // callback — so it is insurance against a hang, not a fixed defect.
    s.once('error', settle);
    s.write('', settle);
  });
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
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([
      Promise.all([flushStream(process.stdout), flushStream(process.stderr)]),
      deadline,
    ]);
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
