import * as path from 'path';
import * as pty from 'node-pty';

const WRITE_CHUNK_BYTES = 8 * 1024;
const WRITE_CHUNK_DELAY_MS = 10;

/**
 * Nested-claude markers that must NOT leak into the wrapped TUI. When
 * interactive claude sees these (set when any claude process is an ancestor,
 * e.g. an agent running the wrapper from inside Claude Code), it switches to
 * SDK child-session behavior and silently stops writing the conversation
 * transcript JSONL — which is this wrapper's source of truth for output.
 * Auth vars like CLAUDE_CODE_OAUTH_TOKEN are intentionally kept.
 */
const SCRUB_ENV_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SSE_PORT',
];

function childEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  for (const key of SCRUB_ENV_VARS) delete env[key];
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
