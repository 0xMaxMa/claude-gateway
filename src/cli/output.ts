/**
 * stdout is the CLI's result channel and carries JSON only — help, prompts,
 * progress and errors all go to stderr, so a caller can pipe stdout straight
 * into `jq` from any command.
 *
 * `compact` (the global `--json` flag) prints one minified line for scripts;
 * the default is pretty-printed for humans. Either way the output is valid
 * JSON. Shared so every command formats its result identically.
 */
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
