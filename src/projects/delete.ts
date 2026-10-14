import { promises as fsp } from 'fs';
import * as path from 'path';
import { err, errnoToCode, ok, ProjectName, ProjectsErrorCode, Result } from './paths';

export type DeleteErrorCode = 'confirm_mismatch' | 'project_running';

/**
 * Removes the project folder under `root`. A project that is a symlink loses only the link, so
 * the folder it points to is never touched. Nested links are removed, not followed.
 */
export async function removeProject(root: string, name: ProjectName): Promise<Result<{ name: ProjectName }, ProjectsErrorCode>> {
  try {
    const realRoot = await fsp.realpath(root);
    const target = path.join(realRoot, name);
    const st = await fsp.lstat(target);
    if (st.isSymbolicLink()) await fsp.unlink(target);
    else if (st.isDirectory()) await fsp.rm(target, { recursive: true, force: false });
    else return err('not_a_directory');
    return ok({ name });
  } catch (e) {
    return err(errnoToCode(e));
  }
}
