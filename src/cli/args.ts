/**
 * CLI argument parser — splits tokens into positionals and flags.
 *
 * Supports `--flag value`, `--flag=value`, and boolean `--flag` (when the next
 * token is another flag or absent). Mirrors the lightweight style already used
 * in src/index.ts (no heavy dependency).
 */
export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
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
    if (tok.startsWith('--')) {
      const body = tok.slice(2);
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
      if (next !== undefined && !next.startsWith('--')) {
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
