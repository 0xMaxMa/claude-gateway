import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { Message } from '../types';
import type { ChatChannelOrApi } from '../history/types';
import { SessionStore } from './store';
import { resolveClaudeBin, pathWithNativeBin } from './claude-bin';

export interface CompactionResult {
  beforeMessages: number;
  afterMessages: number;
  beforeTokens: number;
  afterTokens: number;
  reductionPct: number;
  contextPctBefore: number;
  contextPctAfter: number;
}

export class NotEnoughMessagesError extends Error {
  constructor(count: number) {
    super(`Not enough messages to compact (${count} messages, minimum 5 required)`);
    this.name = 'NotEnoughMessagesError';
  }
}

// Max characters per chunk sent to claude CLI (~100K chars ≈ ~25K tokens, well within 200K limit)
const CHUNK_CHARS = 100_000;
// Number of recent messages to keep verbatim; older messages are summarized
const KEEP_LAST_MESSAGES = 45;
// Prompt used to merge multiple chunk summaries into one
const MERGE_SUMMARIES_PROMPT =
  'These are summaries of sequential parts of a conversation. Merge them into a single concise summary preserving key facts, decisions, context, and any open tasks.';
// Default instruction for summarizing a single conversation or chunk
const SINGLE_SUMMARY_INSTRUCTION =
  'Summarize this conversation concisely, preserving key facts, decisions, context the assistant should remember, and any open questions or unfinished tasks.';
// System prompt prepended to every claude CLI summarization call
const COMPACTOR_SYSTEM_PROMPT =
  'You are a conversation archiver. Your ONLY task is to produce a concise summary of the conversation transcript below. Do NOT respond to the conversation. Do NOT ask questions. Output ONLY the summary.';

// Max concurrent `claude --print` chunk-summary calls in flight at once. Bounded
// (not "all N chunks at once") to cap worst-case concurrent model calls/memory,
// while still cutting sequential wall time roughly by this factor on large sessions.
const CHUNK_CONCURRENCY = 4;
// Attempts per chunk (1 initial + retries) before degrading to a truncated raw
// excerpt instead of failing the whole compact job over one bad chunk.
const CHUNK_MAX_ATTEMPTS = 2;
// Raw-excerpt length used when a chunk exhausts its summarization attempts.
const DEGRADED_EXCERPT_CHARS = 2_000;
// Hard ceiling on a single `claude --print` summarization spawn — mirrors the
// prior spawnSync timeout, but non-blocking (see defaultSpawnClaude below).
const SUMMARY_TIMEOUT_MS = 300_000;

// Rough token estimate: ~4 chars per token
function estimateTokens(messages: Message[]): number {
  return Math.round(messages.reduce((acc, m) => acc + m.content.length, 0) / 4);
}

/** Reports chunk-summarization progress during a multi-chunk compact (done, total). */
export type CompactProgress = (done: number, total: number) => void;

export interface ClaudeCliResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/** Injectable so tests can drive the compactor without a real `claude` binary. */
export type ClaudeCliSpawnFn = (bin: string, args: string[], input: string) => Promise<ClaudeCliResult>;

/**
 * Async `claude` CLI spawn. Replaces the prior `spawnSync` call: `spawnSync`
 * blocks the daemon's single event loop for the full duration of the call — and
 * every agent shares one process, so one compaction call froze ALL agents/
 * channels until it returned (up to SUMMARY_TIMEOUT_MS, x N chunks sequentially
 * on large sessions). `spawn` yields the event loop while the child runs.
 * Mirrors the sync `{status, stdout, stderr, error}` contract so callers'
 * existing error handling is unchanged.
 */
export function defaultSpawnClaude(bin: string, args: string[], input: string): Promise<ClaudeCliResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const settle = (r: ClaudeCliResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      settle({ status: null, stdout: '', stderr, error: new Error(`claude CLI timed out after ${SUMMARY_TIMEOUT_MS}ms`) });
    }, SUMMARY_TIMEOUT_MS);

    const child = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: pathWithNativeBin() },
    });
    child.stdout?.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (err) => settle({ status: null, stdout: '', stderr, error: err as Error }));
    child.on('close', (code) => settle({ status: code, stdout, stderr }));
    // stdin emits its own async 'error' (e.g. EPIPE if the child exits before we
    // finish writing) separate from the child's 'error' event — must be handled
    // or an unhandled stream error crashes the daemon.
    child.stdin?.on('error', () => {});
    try {
      child.stdin?.write(input);
      child.stdin?.end();
    } catch (err) {
      settle({ status: null, stdout: '', stderr, error: err as Error });
    }
  });
}

export class SessionCompactor {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly spawnClaude: ClaudeCliSpawnFn = defaultSpawnClaude,
  ) {}

  async compact(
    agentId: string,
    chatId: string,
    sessionId: string,
    model: string,
    contextWindow: number,
    channel: ChatChannelOrApi = 'telegram',
    onProgress?: CompactProgress,
  ): Promise<CompactionResult> {
    // Load current history
    const messages = await this.sessionStore.loadTelegramSession(agentId, chatId, sessionId, channel);

    if (messages.length < 5) {
      throw new NotEnoughMessagesError(messages.length);
    }

    const beforeMessages = messages.length;
    const beforeTokens = estimateTokens(messages);

    // Archive original before compaction
    const agentsBaseDir = this.sessionStore.getAgentsBaseDir();
    const sessionDir = path.join(agentsBaseDir, agentId, 'sessions', `${channel}-${chatId}`);
    fs.mkdirSync(sessionDir, { recursive: true });
    const archivePath = path.join(sessionDir, `${sessionId}.pre-compact-${Date.now()}.json`);
    fs.writeFileSync(archivePath, JSON.stringify(messages, null, 2), 'utf-8');

    // Keep last N messages verbatim; summarize only the older portion (or all if < N)
    const tail = messages.slice(-KEEP_LAST_MESSAGES);
    const toSummarize = messages.length > KEEP_LAST_MESSAGES ? messages.slice(0, -KEEP_LAST_MESSAGES) : messages;
    const historyText = toSummarize
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n');

    const summaryText = await this.summarizeWithChunking(historyText, model, onProgress);
    const compacted: Message[] = [
      { role: 'system', content: `[Conversation Summary]\n${summaryText}`, ts: Date.now() },
      ...tail,
    ];

    // Save compacted history (original already archived above)
    await this.sessionStore.saveTelegramSession(agentId, chatId, sessionId, compacted, channel);

    const afterMessages = compacted.length;
    const afterTokens = estimateTokens(compacted);
    const reductionPct = beforeTokens > 0 ? Math.max(0, Math.round((1 - afterTokens / beforeTokens) * 100)) : 0;
    const contextPctBefore = Math.round((beforeTokens / contextWindow) * 100);
    const contextPctAfter = Math.round((afterTokens / contextWindow) * 100);

    return { beforeMessages, afterMessages, beforeTokens, afterTokens, reductionPct, contextPctBefore, contextPctAfter };
  }

  private async summarizeWithChunking(historyText: string, model: string, onProgress?: CompactProgress): Promise<string> {
    // If small enough, summarize directly. No chunking → no chunk to retry/degrade
    // against, so a failure here still fails the compact job (original behavior).
    if (historyText.length <= CHUNK_CHARS) {
      return this.callClaudeForSummary(historyText, model);
    }

    // Split into chunks and summarize with bounded concurrency; a single bad
    // chunk degrades to a raw excerpt instead of failing the whole job.
    const chunks = this.splitIntoChunks(historyText, CHUNK_CHARS);
    const chunkSummaries = await this.summarizeChunksConcurrently(chunks, model, onProgress);

    // Merge chunk summaries into final summary. If the merge call itself can't
    // be completed, fall back to the concatenated per-part summaries rather than
    // losing the whole compaction — still far smaller than the raw history.
    const mergedText = chunkSummaries.join('\n\n');
    return this.mergeChunkSummaries(mergedText, model);
  }

  /** Bounded worker pool (mirrors the pattern in apps/installer.ts restoreRunningApps): at
   *  most CHUNK_CONCURRENCY `claude --print` calls in flight; results land by index so
   *  output order matches chunk order regardless of completion order. */
  private async summarizeChunksConcurrently(
    chunks: string[],
    model: string,
    onProgress?: CompactProgress,
  ): Promise<string[]> {
    const results: string[] = new Array(chunks.length);
    let completed = 0;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < chunks.length) {
        const i = cursor++;
        results[i] = await this.summarizeChunkWithFallback(chunks[i], model, i, chunks.length);
        completed++;
        onProgress?.(completed, chunks.length);
      }
    };
    const poolSize = Math.min(CHUNK_CONCURRENCY, chunks.length);
    await Promise.all(Array.from({ length: poolSize }, () => worker()));
    return results;
  }

  /** Summarize one chunk; after CHUNK_MAX_ATTEMPTS failures, degrade to a truncated raw
   *  excerpt instead of throwing, so one bad chunk can't fail the whole compact job. */
  private async summarizeChunkWithFallback(chunk: string, model: string, index: number, total: number): Promise<string> {
    const instruction = `This is part ${index + 1} of ${total} of a longer conversation. Summarize this segment concisely.`;
    let lastErr: Error | undefined;
    for (let attempt = 1; attempt <= CHUNK_MAX_ATTEMPTS; attempt++) {
      try {
        const summary = await this.callClaudeForSummary(chunk, model, instruction);
        return `[Part ${index + 1}/${total}]\n${summary}`;
      } catch (err) {
        lastErr = err as Error;
      }
    }
    const excerpt = chunk.length > DEGRADED_EXCERPT_CHARS ? `${chunk.slice(0, DEGRADED_EXCERPT_CHARS)}…(truncated)` : chunk;
    return `[Part ${index + 1}/${total} — summarization failed after ${CHUNK_MAX_ATTEMPTS} attempts (${lastErr?.message ?? 'unknown error'}); showing truncated raw excerpt]\n${excerpt}`;
  }

  /** Merge per-chunk summaries into one; degrade to the unmerged concatenation on repeated failure. */
  private async mergeChunkSummaries(mergedText: string, model: string): Promise<string> {
    for (let attempt = 1; attempt <= CHUNK_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.callClaudeForSummary(mergedText, model, MERGE_SUMMARIES_PROMPT);
      } catch {
        // retry, then degrade below
      }
    }
    return mergedText;
  }

  private splitIntoChunks(text: string, maxChars: number): string[] {
    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      let end = start + maxChars;
      if (end < text.length) {
        // Break at a newline boundary to avoid splitting mid-message
        const boundary = text.lastIndexOf('\n\n', end);
        if (boundary > start) end = boundary;
      }
      chunks.push(text.slice(start, end));
      start = end;
    }

    return chunks;
  }

  private async callClaudeForSummary(
    text: string,
    model: string,
    instruction = SINGLE_SUMMARY_INSTRUCTION,
  ): Promise<string> {
    // Wrap content in XML tags so claude treats it as data to analyze, not an active conversation
    const prompt = `${COMPACTOR_SYSTEM_PROMPT}\n\n${instruction}\n\n<transcript>\n${text}\n</transcript>\n\nWrite a concise summary of the above transcript now:`;

    // Resolve claude the same way the session subprocess does: honor CLAUDE_BIN
    // (which may carry args), else probe PATH and the native/legacy install
    // locations. This runs in the gateway's own (possibly minimal) PATH, so
    // without resolution `claude --print` would fail identically to a session
    // spawn after the native-installer migration.
    const claudeBinRaw = process.env.CLAUDE_BIN ?? resolveClaudeBin().bin;
    const [claudeBin, ...claudeBinArgs] = claudeBinRaw.split(' ');

    const result = await this.spawnClaude(claudeBin, [...claudeBinArgs, '--print', '--model', model], prompt);

    if (result.error) {
      throw new Error(`claude CLI error: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const stderr = result.stderr?.trim() ?? '';
      throw new Error(`claude CLI exited with status ${result.status}: ${stderr}`);
    }

    return result.stdout?.trim() ?? '';
  }
}
