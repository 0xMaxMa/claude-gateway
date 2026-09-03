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

/** True for anything that reads as a flag rather than a value: `--name`,
 *  `--name=value`, or one of the aliases above. A token like `-5` is a value,
 *  and so is an unrecognised `-x` — treating every `-letter` as a flag would
 *  silently swallow the token after it as that flag's value. */
function looksLikeFlag(token: string): boolean {
  return token.startsWith('--') || (token.length === 2 && token[0] === '-' && token[1] in SHORT_ALIASES);
}

/**
 * `booleanFlags` names flags that must never consume the next token as a value
 * (e.g. `--force <positional>` should leave `<positional>` alone). Without this,
 * a boolean flag placed right before a positional silently swallows it — the
 * parser has no schema of its own, so it can only be told which names are
 * boolean by the caller. Flags not in this set keep the default heuristic
 * (consume the next token unless it looks like another flag).
 *
 * A declared boolean flag's `--flag=value` form is parsed as a boolean too
 * (`value !== 'false'`), not left as a raw string — otherwise `--force=true`
 * silently reads as truthy-but-not-`true`, and a strict `flags.force === true`
 * check downstream (as `service install` does) refuses despite the explicit
 * override. `--force=false` is the one form that's meant to read as off.
 */
export function parseCliArgs(tokens: string[], booleanFlags: ReadonlySet<string> = new Set()): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (looksLikeFlag(tok)) {
      const body = tok.startsWith('--') ? tok.slice(2) : SHORT_ALIASES[tok.slice(1)];
      const eq = body.indexOf('=');
      if (eq !== -1) {
        const key = body.slice(0, eq);
        const value = body.slice(eq + 1);
        flags[key] = booleanFlags.has(key) ? value !== 'false' : value;
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
