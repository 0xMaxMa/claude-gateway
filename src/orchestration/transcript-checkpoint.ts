import { constants } from 'fs';
import { open, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';

export interface TranscriptCheckpoint { path: string; size: number; ino: number; dev: number; }

/** Only existing, private CLI transcripts are eligible. Never rewind a fresh session. */
export async function checkpointTranscript(path: string): Promise<TranscriptCheckpoint | undefined> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || !stat.size) return;
      return { path, size: stat.size, ino: stat.ino, dev: stat.dev };
    } finally { await file.close(); }
  } catch { return; }
}

/** After confirmed CLI shutdown, remove only an unanswered attempt's appended
 * input/metadata. Real assistant output, tool results, compaction boundaries and
 * unknown records fail closed. Keep the discarded bytes in a private diagnostic
 * archive; the user's input and task receipts remain in the orchestration DB. */
export async function rollbackUnansweredTranscript(checkpoint: TranscriptCheckpoint): Promise<boolean> {
  const metadata = new Set(['queue-operation', 'attachment', 'last-prompt', 'ai-title', 'mode', 'atis-latch']);
  try {
    const file = await open(checkpoint.path, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      const length = stat.size - checkpoint.size;
      if (stat.ino !== checkpoint.ino || stat.dev !== checkpoint.dev || length <= 0 || length > 8 * 1024 * 1024) return false;
      const tail = Buffer.alloc(length);
      const { bytesRead } = await file.read(tail, 0, length, checkpoint.size);
      if (bytesRead !== length || tail[length - 1] !== 10) return false;
      let hasInput = false;
      for (const line of tail.toString('utf8').split('\n').filter(Boolean)) {
        const row = JSON.parse(line);
        if (row.type === 'user') {
          const content = row.message?.content;
          if (typeof content !== 'string' && (!Array.isArray(content) || content.some((b: any) => !['text', 'image'].includes(b.type)))) return false;
          hasInput = true;
        } else if (row.type === 'assistant') {
          if (!Array.isArray(row.message?.content) || row.message.content.some((b: any) => b.type !== 'text')) return false;
          if (row.isApiErrorMessage !== true && (row.message?.model !== '<synthetic>' ||
              row.message.content.some((b: any) => b.text !== 'No response requested.'))) return false;
        } else if (!metadata.has(row.type)) return false;
      }
      if (!hasInput) return false;
      await writeFile(`${checkpoint.path}.failed-turn-${randomUUID()}`, tail, { mode: 0o600, flag: 'wx' });
      const current = await file.stat();
      if (current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) return false;
      await file.truncate(checkpoint.size);
      return true;
    } finally { await file.close(); }
  } catch { return false; }
}
