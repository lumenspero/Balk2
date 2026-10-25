import { normalizePath } from '../graph.js';
import type { IncludeOptions } from './balk2-config.js';

/** The include patterns and the test-code switch, from either form of the `include` option. */
export function resolveInclude(include: readonly string[] | IncludeOptions | undefined): {
  patterns: readonly string[] | undefined;
  tests: boolean;
} {
  if (include === undefined) return { patterns: undefined, tests: true };
  if (Array.isArray(include)) return { patterns: include as readonly string[], tests: true };
  const options = include as IncludeOptions;
  return { patterns: options.patterns, tests: options.tests ?? true };
}

/**
 * Filter a list of file paths against include and exclude pattern arrays.
 *
 * Exclude rules override include rules.
 */
export function filterFilesWithConfig(
  filePaths: readonly string[],
  include?: readonly string[],
  exclude?: readonly string[],
): string[] {
  return filePaths.filter((filePath) => {
    const norm = normalizePath(filePath);

    // 1. Check exclude
    if (exclude && exclude.length > 0) {
      if (exclude.some((pattern) => matchPattern(norm, pattern))) {
        return false;
      }
    }

    // 2. Check include
    if (include && include.length > 0) {
      return include.some((pattern) => matchPattern(norm, pattern));
    }

    return true;
  });
}

/**
 * Match a normalized path against a glob-style pattern.
 */
export function matchPattern(path: string, pattern: string): boolean {
  const normPath = normalizePath(path);
  const normPattern = normalizePath(pattern);

  // Exact match
  if (normPath === normPattern) return true;

  // Prefix directory match e.g. "src" or "node_modules/"
  if (normPattern.endsWith('/') && normPath.startsWith(normPattern)) return true;
  if (!normPattern.includes('*') && normPath.startsWith(`${normPattern}/`)) return true;

  const regex = globToRegex(normPattern);
  return regex.test(normPath);
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '___GLOB_STAR_STAR___')
    .replace(/\*/g, '___GLOB_STAR___')
    .replace(/\?/g, '___GLOB_QUESTION___');

  const regexStr = escaped
    .replace(/___GLOB_STAR_STAR___/g, '.*')
    .replace(/___GLOB_STAR___/g, '[^/]*')
    .replace(/___GLOB_QUESTION___/g, '.');

  return new RegExp(`^${regexStr}$`);
}
