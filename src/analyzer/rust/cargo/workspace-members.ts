import type { CargoWorkspaceSection } from './manifest.js';
import { joinRepoPath } from './manifest.js';
import { globToRegExp } from '../../../packages/glob.js';

export { globToRegExp };

/**
 * The member patterns of a workspace root that match no package directory, as written (Phase 7.4).
 * A pattern that matches only excluded directories still counts as matched.
 */
export function unmatchedMemberPatterns(
  rootDir: string,
  workspace: CargoWorkspaceSection,
  candidateDirs: readonly string[],
): string[] {
  return workspace.members.filter((pattern) => {
    const regex = globToRegExp(joinRepoPath(rootDir, pattern));
    return !candidateDirs.some((dir) => regex.test(dir));
  });
}

/**
 * The repository-relative package directories that a workspace root makes members (V3 Phase 7.2).
 * `members` and `exclude` are resolved against the root's directory, and only directories that
 * contain a `Cargo.toml` (`candidateDirs`) can match. A root package is always a member.
 */
export function workspaceMemberDirs(
  rootDir: string,
  workspace: CargoWorkspaceSection,
  candidateDirs: readonly string[],
  rootIsPackage: boolean,
): ReadonlySet<string> {
  const include = workspace.members.map((pattern) => globToRegExp(joinRepoPath(rootDir, pattern)));
  const exclude = workspace.exclude.map((pattern) => globToRegExp(joinRepoPath(rootDir, pattern)));
  const members = new Set<string>();
  if (rootIsPackage) members.add(rootDir);
  for (const dir of candidateDirs) {
    if (include.some((pattern) => pattern.test(dir))) {
      if (!exclude.some((pattern) => pattern.test(dir))) members.add(dir);
    }
  }
  return members;
}
