import { randomUUID } from 'crypto';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { resolveDir } from './fs';
import { addHold, findHold, Hold, releaseHold } from './holds';
import { errnoToCode, FilesErrorCode, pathSegments, RelPath } from './paths';
import { pathWithin } from '../utils/paths';
import { err, ok, Result } from '../utils/result';
import type { Logger } from '../types';

export type DeleteErrorCode = 'in_use' | 'deleting';

export interface Removed {
  path: RelPath;
  warning?: string;
}

export interface DeleteDeps {
  logger: Logger;
  /** A chat turn, a spawning session or a task works in this real folder, in one inside it, or in one holding it. */
  inUse: (realDir: string) => boolean | Promise<boolean>;
}

type DeleteResult = Result<Removed, FilesErrorCode | DeleteErrorCode>;

/** Linux lists every mount point here; elsewhere the parent device check is all there is. */
const MOUNTINFO = '/proc/self/mountinfo';

/** mountinfo escapes space, tab, newline and backslash as three octal digits. */
function unescapeMount(p: string): string {
  return p.replace(/\\([0-7]{3})/g, (_m, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

async function holdsMountPoint(dir: string): Promise<boolean> {
  const text = await fsp.readFile(MOUNTINFO, 'utf8').catch(() => null);
  if (text === null) return false;
  return text.split('\n').some((line) => {
    const mountPoint = line.split(' ')[4];
    return mountPoint !== undefined && pathWithin(dir, unescapeMount(mountPoint));
  });
}

/**
 * Removes the folder `rel` names under `root`. An entry that is a symlink loses only the link, so the folder it points
 * to is never touched. Nested links are removed, not followed. Every folder above the entry must be a real folder, not
 * a link, and the entry must sit on its parent's filesystem with no mount point inside it, so a delete never reaches
 * another filesystem.
 *
 * A folder is first renamed to a hidden sibling, which entry names cannot start with, so it leaves the list in one
 * atomic step. A recursive rm that fails partway cannot be undone, so what it could not remove stays hidden and the
 * caller gets a warning instead of an entry that is listed with half its files gone.
 */
export async function deleteEntry(root: string, rel: RelPath, deps: DeleteDeps): Promise<DeleteResult> {
  const segments = pathSegments(rel);
  const name = segments.pop();
  if (name === undefined) return err('invalid_path');
  let parent: string;
  try {
    const lexicalParent = path.join(await fsp.realpath(root), ...segments);
    parent = await fsp.realpath(lexicalParent);
    if (parent !== lexicalParent) return err('symlink_in_path');
  } catch (e) {
    return err(errnoToCode(e));
  }
  const dir = await resolveDir(root, rel);
  if (!dir.ok) return dir;
  const held = (): DeleteErrorCode | undefined => {
    const hold = findHold(dir.value);
    return hold ? heldCode(hold) : undefined;
  };
  const before = held();
  if (before) return err(before);
  const busy = async () => Boolean(await deps.inUse(dir.value));
  // Checked before the hold, so a turn that began earlier is seen here and never refused by the hold.
  if (await busy()) return err('in_use');
  const now = held();
  if (now) return err(now);
  const hold = addHold(dir.value);
  try {
    if (await busy()) return err('in_use');
    return await remove(parent, rel, name, deps.logger);
  } finally {
    releaseHold(hold.id);
  }
}

function heldCode(hold: Hold): DeleteErrorCode {
  return 'deleting';
}

async function remove(parent: string, rel: RelPath, name: string, logger: Logger): Promise<DeleteResult> {
  const target = path.join(parent, name);
  let trash: string;
  try {
    const st = await fsp.lstat(target);
    if (st.isSymbolicLink()) {
      await fsp.unlink(target);
      return ok({ path: rel });
    }
    if (!st.isDirectory()) return err('not_a_directory');
    if (st.dev !== (await fsp.stat(parent)).dev || (await holdsMountPoint(target))) return err('cross_device');
    trash = path.join(parent, `.deleting-${name}-${randomUUID()}`);
    await fsp.rename(target, trash);
  } catch (e) {
    return err(errnoToCode(e));
  }
  try {
    await fsp.rm(trash, { recursive: true, force: false });
    return ok({ path: rel });
  } catch (e) {
    logger.warn(`files: removing ${trash} failed: ${(e as Error).message}`);
    return ok({ path: rel, warning: `Some files could not be removed and remain in ${trash}. Remove that folder by hand: rm -rf ${trash}` });
  }
}
