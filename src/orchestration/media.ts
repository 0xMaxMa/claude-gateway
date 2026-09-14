import { createHash } from 'crypto';
import { readFileSync, mkdirSync, writeFileSync, statSync, openSync, closeSync, fsyncSync } from 'fs';
import { join, extname } from 'path';
import { OrchestrationError } from './types';
import { MediaStore } from '../history/media-store';

/** Content-addressed ingestion keeps provider retries bound to the same bytes. */
export function ingestOrchestrationMedia(agentsRoot: string, agentId: string, chatId: string, source: string): string {
  if (statSync(source).size > 50 * 1024 * 1024) throw new OrchestrationError('ATTACHMENT_TOO_LARGE');
  const bytes = readFileSync(source);
  if (bytes.length > 50 * 1024 * 1024) throw new OrchestrationError('ATTACHMENT_TOO_LARGE');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const suffix = extname(source).slice(0, 12).replace(/[^a-zA-Z0-9.]/g, '');
  const relative = join('media', chatId, `orchestration-${digest}${suffix}`);
  const destination = MediaStore.resolvePath(agentsRoot, agentId, relative);
  mkdirSync(join(destination, '..'), { recursive: true, mode: 0o700 });
  try {
    const file = openSync(destination, 'wx', 0o600);
    try { writeFileSync(file, bytes); fsyncSync(file); } finally { closeSync(file); }
    const directory = openSync(join(destination, '..'), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (createHash('sha256').update(readFileSync(destination)).digest('hex') !== digest) throw new OrchestrationError('ATTACHMENT_RECONCILIATION_REQUIRED');
  }
  return relative;
}
