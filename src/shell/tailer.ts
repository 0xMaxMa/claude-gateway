import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface UsageInfo {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
}

export interface AssistantRecord {
  type: 'assistant';
  isSidechain?: boolean;
  message: {
    role: 'assistant';
    content: Array<{ type: string; [k: string]: unknown }>;
    stop_reason?: string | null;
    usage?: UsageInfo;
  };
  uuid?: string;
  timestamp?: string;
}

export interface TailerEvents {
  /** A new (non-sidechain) assistant record was appended. */
  onAssistant: (record: AssistantRecord) => void;
  /** Claude finished a turn (system/turn_duration record). */
  onTurnEnd: (durationMs: number) => void;
  onError: (err: Error) => void;
}

/** cwd → Claude Code project-dir slug (verified: `/` and `.` both become `-`). */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

export function transcriptPath(cwd: string, sessionId: string): string {
  return path.join(os.homedir(), '.claude', 'projects', projectSlug(cwd), `${sessionId}.jsonl`);
}

/**
 * Incrementally reads the session transcript JSONL that interactive Claude
 * Code appends to *during* a turn. This is the text source of truth and the
 * streaming source: records are surfaced the moment they hit the file.
 */
export class TranscriptTailer {
  private offset = 0;
  private partialLine = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private resolvedPath: string | null = null;
  /** Total records dispatched since start — non-zero means claude is writing output. */
  seenRecords = 0;
  /** Timestamp of last fallback scan — caps expensive readdirSync to once per 2s. */
  private lastFallbackScanMs = 0;
  private static readonly FALLBACK_SCAN_INTERVAL_MS = 2_000;

  constructor(
    private readonly cwd: string,
    private readonly sessionId: string,
    private readonly events: TailerEvents,
    private readonly pollMs = 150,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.poll(), this.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Force one synchronous read (used right before emitting a result). */
  flush(): void {
    this.poll();
  }

  private findFile(): string | null {
    if (this.resolvedPath) return this.resolvedPath;
    const expected = transcriptPath(this.cwd, this.sessionId);
    if (fs.existsSync(expected)) {
      this.resolvedPath = expected;
      return expected;
    }
    // Fallback if the slug scheme ever changes: scan project dirs for the uuid.
    // Capped to once per 2s — readdirSync over hundreds of project dirs every 150ms poll
    // is expensive before the transcript file has been created.
    const now = Date.now();
    if (now - this.lastFallbackScanMs < TranscriptTailer.FALLBACK_SCAN_INTERVAL_MS) return null;
    this.lastFallbackScanMs = now;
    const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(projectsRoot); } catch { return null; }
    for (const dir of dirs) {
      const candidate = path.join(projectsRoot, dir, `${this.sessionId}.jsonl`);
      if (fs.existsSync(candidate)) {
        this.resolvedPath = candidate;
        return candidate;
      }
    }
    return null;
  }

  private poll(): void {
    const file = this.findFile();
    if (!file) return;
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return; // transient: file rotated/removed
    }
    if (size <= this.offset) return;

    let chunk: string;
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(size - this.offset);
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      fs.closeSync(fd);
      chunk = buf.toString('utf8');
    } catch (err) {
      this.events.onError(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.offset = size;

    const data = this.partialLine + chunk;
    const lines = data.split('\n');
    this.partialLine = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // Mid-write torn line should be impossible (we split on \n), so a bad
        // line is real corruption — surface it, never swallow.
        this.events.onError(new Error(`unparseable transcript line (${line.length} bytes)`));
        continue;
      }
      this.dispatch(record);
    }
  }

  private dispatch(record: Record<string, unknown>): void {
    if (record.isSidechain === true) return; // subagent-internal records
    this.seenRecords++;
    if (record.type === 'assistant') {
      const message = record.message as AssistantRecord['message'] | undefined;
      if (message && Array.isArray(message.content)) {
        this.events.onAssistant(record as unknown as AssistantRecord);
      }
      return;
    }
    if (record.type === 'system' && record.subtype === 'turn_duration') {
      const durationMs = typeof record.durationMs === 'number' ? record.durationMs : 0;
      this.events.onTurnEnd(durationMs);
    }
  }
}
