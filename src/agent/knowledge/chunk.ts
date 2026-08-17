/**
 * Markdown line-accumulator chunker (planning-64 K0).
 *
 * Splits a file into overlapping, line-aligned chunks sized by an approximate
 * token budget. Mirrors openclaw memory-core's `chunkMarkdown` line accumulator:
 * fill until adding the next line would exceed the char budget, flush, then carry
 * a trailing overlap tail into the next chunk. Line-aligned so `memory_get`
 * excerpts map back to real line ranges. Deterministic — no model calls.
 */

/** Rough chars-per-token estimate (matches openclaw's estimate). */
const CHARS_PER_TOKEN = 4;

export interface Chunk {
  startLine: number; // 1-indexed, inclusive
  endLine: number; // 1-indexed, inclusive
  text: string;
}

/**
 * @param content    full file text
 * @param chunkTokens target chunk size in ~tokens
 * @param overlap     overlap between consecutive chunks in ~tokens (< chunkTokens)
 */
export function chunkMarkdown(content: string, chunkTokens: number, overlap: number): Chunk[] {
  const maxChars = Math.max(32, chunkTokens * CHARS_PER_TOKEN);
  const overlapChars = Math.max(0, overlap * CHARS_PER_TOKEN);

  // Preserve line structure; a file with no trailing newline still yields its lines.
  const lines = content.split('\n');
  const chunks: Chunk[] = [];

  // Current chunk accumulator: 1-indexed start line + the lines it holds.
  let startLine = 1;
  let buf: string[] = [];
  let bufChars = 0;

  const flush = (endLine: number): void => {
    const text = buf.join('\n').trim();
    if (text.length > 0) {
      chunks.push({ startLine, endLine, text });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1; // 1-indexed
    const addLen = line.length + 1; // +1 for the joining newline

    // Flush before overflowing — but only if the buffer already has content
    // (a single over-long line becomes its own chunk rather than an empty flush).
    if (bufChars > 0 && bufChars + addLen > maxChars) {
      flush(lineNo - 1);

      // Carry an overlap tail: keep trailing lines whose cumulative length stays
      // under overlapChars, but ALWAYS drop at least the first line of the
      // flushed chunk so the window advances (no infinite loop).
      const carry: string[] = [];
      let carryChars = 0;
      for (let j = buf.length - 1; j >= 1; j--) {
        const l = buf[j];
        if (carryChars + l.length + 1 > overlapChars) break;
        carry.unshift(l);
        carryChars += l.length + 1;
      }
      buf = carry;
      bufChars = carryChars;
      startLine = lineNo - carry.length;
    }

    buf.push(line);
    bufChars += addLen;
  }

  if (bufChars > 0) flush(lines.length);
  return chunks;
}
