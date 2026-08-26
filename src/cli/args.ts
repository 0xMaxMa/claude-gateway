/**
 * CLI argument parser — splits tokens into positionals and flags.
 *
 * Supports `--flag value`, `--flag=value`, boolean `--flag` (when the next
 * token is another flag or absent), and single-dash aliases such as `-h`.
 * Mirrors the lightweight style already used in src/index.ts (no dependency).
 */
export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** Single-dash aliases, expanded to the long name before anything else sees
 *  them. `-h` is already honoured as a bare top-level token; without this it
 *  fell through to a positional, so `crons -h` reported "Unknown command". */
export const SHORT_ALIASES: Readonly<Record<string, string>> = { h: 'help', V: 'version' };

const SHORT_FLAG = /^-[A-Za-z]$/;

/** True for anything that reads as a flag rather than a value: `--name`,
 *  `--name=value`, or a single-dash letter. A token like `-5` is a value. */
function looksLikeFlag(token: string): boolean {
  return token.startsWith('--') || SHORT_FLAG.test(token);
}

/**
 * `booleanFlags` names flags that must never consume the next token as a value
 * (e.g. `--force <positional>` should leave `<positional>` alone). Without this,
 * a boolean flag placed right before a positional silently swallows it — the
 * parser has no schema of its own, so it can only be told which names are
 * boolean by the caller. Flags not in this set keep the default heuristic
 * (consume the next token unless it looks like another flag).
 */
export function parseCliArgs(tokens: string[], booleanFlags: ReadonlySet<string> = new Set()): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (looksLikeFlag(tok)) {
      const body = tok.startsWith('--') ? tok.slice(2) : (SHORT_ALIASES[tok.slice(1)] ?? tok.slice(1));
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      if (booleanFlags.has(body)) {
        flags[body] = true;
        continue;
      }
      const next = tokens[i + 1];
      if (next !== undefined && !looksLikeFlag(next)) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
    } else {
      positionals.push(tok);
    }
  }
  return { positionals, flags };
}
