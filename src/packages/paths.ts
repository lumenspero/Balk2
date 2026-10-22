import { posix } from 'node:path';

/** The repository-relative directory of a repository-relative file path. The root is `.`. */
export function packageDirOf(filePath: string): string {
  return posix.dirname(filePath);
}

/**
 * Resolves `relative` against the repository-relative directory `dir`, with `/` separators and no
 * `./` or `..` segments left inside the repository. A path that leaves the repository keeps its
 * leading `..`.
 */
export function repoPath(dir: string, relative: string): string {
  return posix.normalize(posix.join(dir, relative));
}
