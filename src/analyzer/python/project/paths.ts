/**
 * Repository-relative path helpers for package discovery. `normalizePath` only converts separators
 * and strips a leading `./`. These helpers also resolve `.` and `..` segments. The repository root
 * is `.`.
 */

/** Join a manifest's directory and a path declared relative to it. */
export function joinRepoPath(dir: string, relative: string): string {
  const segments: string[] = [];
  for (const segment of `${dir}/${relative}`.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments.length > 0 ? segments.join('/') : '.';
}

/** The directory that contains a repository-relative file path. A root-level file gives `.`. */
export function dirOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash < 0 ? '.' : normalized.slice(0, slash);
}
