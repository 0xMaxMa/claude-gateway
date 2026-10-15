import { randomUUID } from 'crypto';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { err, errnoToCode, ok, ProjectName, ProjectsErrorCode, Result } from './paths';

export type DeleteErrorCode = 'confirm_mismatch' | 'project_running' | 'project_deleting';

export interface RemovedProject {
  name: ProjectName;
  warning?: string;
}

/**
 * Removes the project folder under `root`. A project that is a symlink loses only the link, so
 * the folder it points to is never touched. Nested links are removed, not followed.
 *
 * A folder is first renamed to a hidden sibling, which project names cannot start with, so the
 * project leaves the list in one atomic step. A recursive rm that fails partway cannot be undone,
 * so what it could not remove stays hidden and the caller gets a warning instead of a project
 * that is listed with half its files gone.
 */
export async function removeProject(root: string, name: ProjectName): Promise<Result<RemovedProject, ProjectsErrorCode>> {
  let trash: string;
  try {
    const realRoot = await fsp.realpath(root);
    const target = path.join(realRoot, name);
    const st = await fsp.lstat(target);
    if (st.isSymbolicLink()) {
      await fsp.unlink(target);
      return ok({ name });
    }
    if (!st.isDirectory()) return err('not_a_directory');
    trash = path.join(realRoot, `.deleting-${name}-${randomUUID()}`);
    await fsp.rename(target, trash);
  } catch (e) {
    return err(errnoToCode(e));
  }
  try {
    await fsp.rm(trash, { recursive: true, force: false });
    return ok({ name });
  } catch (e) {
    console.warn(`projects: removing ${trash} failed: ${(e as Error).message}`);
    return ok({ name, warning: `Some files could not be removed and remain in ${trash}` });
  }
}
