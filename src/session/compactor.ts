import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { Message } from '../types';
import { SessionStore } from './store';

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

// Rough token estimate: ~4 chars per token
function estimateTokens(messages: Message[]): number {
  return Math.round(messages.reduce((acc, m) => acc + m.content.length, 0) / 4);
}

export class SessionCompactor {
  constructor(private readonly sessionStore: SessionStore) {}

  async compact(
    agentId: string,
    chatId: string,
    sessionId: string,
    model: string,
    contextWindow: number,
    channel: 'telegram' | 'discord' = 'telegram',
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

    const summaryText = await this.summarizeWithChunking(historyText);
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

  private async summarizeWithChunking(historyText: string): Promise<string> {
    // If small enough, summarize directly
    if (historyText.length <= CHUNK_CHARS) {
      return this.callClaudeForSummary(historyText);
    }

    // Split into chunks and summarize each
    const chunks = this.splitIntoChunks(historyText, CHUNK_CHARS);
    const chunkSummaries: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const summary = await this.callClaudeForSummary(
        chunks[i],
        `This is part ${i + 1} of ${chunks.length} of a longer conversation. Summarize this segment concisely.`,
      );
      chunkSummaries.push(`[Part ${i + 1}/${chunks.length}]\n${summary}`);
    }

    // Merge chunk summaries into final summary
    const mergedText = chunkSummaries.join('\n\n');
    return this.callClaudeForSummary(
      mergedText,
      MERGE_SUMMARIES_PROMPT,
    );
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
    instruction = SINGLE_SUMMARY_INSTRUCTION,
  ): Promise<string> {
    // Wrap content in XML tags so claude treats it as data to analyze, not an active conversation
    const prompt = `${COMPACTOR_SYSTEM_PROMPT}\n\n${instruction}\n\n<transcript>\n${text}\n</transcript>\n\nWrite a concise summary of the above transcript now:`;

    const result = spawnSync('claude', ['--print'], {
      input: prompt,
      encoding: 'utf-8',
      timeout: 300_000,
      env: process.env,
    });

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
