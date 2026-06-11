import * as path from 'path';
import * as pty from 'node-pty';

const WRITE_CHUNK_BYTES = 8 * 1024;
const WRITE_CHUNK_DELAY_MS = 10;

// Keys matching these prefixes are scrubbed before spawning the child PTY:
// CLAUDECODE/CLAUDE_CODE_ prevent nested-claude child-session behavior that
// silently stops transcript JSONL writes; CLAUDE_REAL_BIN is a wrapper-only
// variable and must not leak into the child.
const SCRUB_ENV_PREFIXES = ['CLAUDECODE', 'CLAUDE_CODE_', 'CLAUDE_REAL_BIN'];

// Auth vars that share the CLAUDE_CODE_ prefix but must be kept.
const SCRUB_ENV_KEEPLIST = new Set(['CLAUDE_CODE_OAUTH_TOKEN']);

function childEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  for (const key of Object.keys(env)) {
    if (
      !SCRUB_ENV_KEEPLIST.has(key) &&
      SCRUB_ENV_PREFIXES.some((p) => key.startsWith(p))
    ) {
      delete env[key];
    }
  }
  return env;
}

export interface PtyHostOptions {
  cols: number;
  rows: number;
  cwd: string;
  onData: (data: string) => void;
  onExit: (exitCode: number) => void;
}

/** Hosts the real interactive `claude` inside a pseudo-terminal. */
export class PtyHost {
  private child: pty.IPty;

  constructor(binary: string, args: string[], opts: PtyHostOptions) {
    // Recursion guard: CLAUDE_BIN points at this wrapper; the wrapper must
    // never resolve the "real" binary back to itself.
    if (path.basename(binary).includes('claude-pty-shell')) {
      throw new Error(`refusing to spawn self as claude binary: ${binary}`);
    }
    this.child = pty.spawn(binary, args, {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: childEnv(),
    });
    this.child.onData(opts.onData);
    this.child.onExit(({ exitCode }) => opts.onExit(exitCode));
  }

  /** Raw keystroke write (control sequences allowed — caller sanitizes user text). */
  writeRaw(data: string): void {
    this.child.write(data);
  }

  /**
   * Paste large text without overwhelming the PTY line discipline:
   * chunked writes with small delays.
   */
  async writeChunked(data: string): Promise<void> {
    for (let i = 0; i < data.length; i += WRITE_CHUNK_BYTES) {
      this.child.write(data.slice(i, i + WRITE_CHUNK_BYTES));
      if (i + WRITE_CHUNK_BYTES < data.length) {
        await new Promise((r) => setTimeout(r, WRITE_CHUNK_DELAY_MS));
      }
    }
  }

  kill(signal?: string): void {
    try {
      this.child.kill(signal);
    } catch {
      /* already dead */
    }
  }
}
