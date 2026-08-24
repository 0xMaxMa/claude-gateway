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

export function parseCliArgs(tokens: string[]): ParsedArgs {
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
