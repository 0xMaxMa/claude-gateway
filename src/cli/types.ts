/** Types shared between the CLI runtime and the generated command table. */

export interface GeneratedFlag {
  name: string;
  in: 'query' | 'body';
  boolean?: boolean;
  required?: boolean;
  description?: string;
}

/** One friendly `<noun> <verb>` command, derived from a route's CLI mapping. */
export interface GeneratedCommand {
  noun: string;
  verb: string;
  method: string;
  /** API path with `:param` placeholders (mounted under /api server-side). */
  path: string;
  /** Positional argument names, in order, filling the path params. */
  args: string[];
  flags: GeneratedFlag[];
  summary: string;
  auth: string;
}
