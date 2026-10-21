import { constants } from 'fs';
import { mkdir, realpath, link, open, lstat, unlink, rename } from 'fs/promises';
import { basename, extname, join, relative, isAbsolute } from 'path';
import { pipeline } from 'stream/promises';
import { randomUUID, createHash } from 'crypto';
import { OrchestrationError } from './types';

/** Keep task-authorized files in the API's session root without attachment ingestion. */
export async function prepareSharePath(source: string, mediaDir: string): Promise<string> {
  await mkdir(mediaDir, { recursive: true, mode: 0o700 });
  // Do not follow a redirected session directory outside the agent media root.
  const root = await realpath(join(mediaDir, '..'));
  const agentRoot = await realpath(join(mediaDir, '..', '..'));
  const directory = await realpath(mediaDir);
  if (root !== join(agentRoot, 'media') || directory !== join(root, basename(mediaDir))) throw new OrchestrationError('ARTIFACT_PATH_DENIED');
  const ref = relative(directory, source);
  if (ref && !ref.startsWith('..') && !isAbsolute(ref)) return source;
  const suffix = extname(source).slice(0, 12).replace(/[^a-zA-Z0-9.]/g, '');
  const name = `share-${createHash('sha256').update(source).digest('hex')}${suffix}`;
  const destination = join(directory, name);
  const temporary = join(directory, `.share-${randomUUID()}`);
  try {
    try { await link(source, temporary); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      // Separate mounts cannot hard-link. Stream from a no-follow descriptor instead.
      const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await input.stat()).isFile()) throw new OrchestrationError('ARTIFACT_PATH_DENIED');
        const output = await open(temporary, 'wx', 0o600);
        try { await pipeline(input.createReadStream(), output.createWriteStream()); }
        finally { await output.close(); }
      } finally { await input.close(); }
    }
    if (!(await lstat(temporary)).isFile()) throw new OrchestrationError('ARTIFACT_PATH_DENIED');
    await rename(temporary, destination);
    return destination;
  } finally {
    // POSIX rename is a no-op when both names already refer to the same inode.
    try { await unlink(temporary); } catch (cleanup) {
      if ((cleanup as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanup;
    }
  }
}
