import { normalizePath } from '../graph.js';

/**
 * Common extension candidates tried when resolving extensionless or TS/JS module imports.
 */
const EXTENSION_CANDIDATES: readonly string[] = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.jsx',
];

/**
 * Resolve an import specifier relative to a source file path.
 *
 * Examples:
 *   resolveImportPath('src/main.ts', './util.js', knownFiles) => 'src/util.ts'
 *   resolveImportPath('src/pages/Home.tsx', '../components/Button', knownFiles) => 'src/components/Button.tsx'
 *
 * @param fromFilePath Repository-relative path of the importing file (e.g. 'src/main.ts')
 * @param specifier Import module specifier (e.g. './util.js', 'lodash')
 * @param knownFiles Optional set of known relative file paths in the repository
 * @returns Resolved repository-relative path, or undefined if non-relative / unresolvable
 */
export function resolveImportPath(
  fromFilePath: string,
  specifier: string,
  knownFiles?: ReadonlySet<string> | readonly string[],
): string | undefined {
  // Only resolve relative imports (starting with ./ or ../)
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    // Unless the specifier happens to match a known relative file directly
    if (knownFiles && isKnownFile(specifier, knownFiles)) {
      return normalizePath(specifier);
    }
    return undefined;
  }

  const normalizedFrom = normalizePath(fromFilePath);
  const parts = normalizedFrom.split('/');
  parts.pop(); // Remove file name, keep directory parts

  const specParts = specifier.split('/');
  for (const part of specParts) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      parts.pop();
    } else {
      parts.push(part);
    }
  }

  const basePath = parts.join('/');
  const knownSet = knownFiles ? toSet(knownFiles) : undefined;

  if (!knownSet) {
    return normalizePath(basePath);
  }

  // Exact match
  if (knownSet.has(basePath)) {
    return basePath;
  }

  // Handle ES module TypeScript convention: import './foo.js' where file is './foo.ts'
  if (basePath.endsWith('.js')) {
    const tsPath = basePath.slice(0, -3) + '.ts';
    if (knownSet.has(tsPath)) return tsPath;

    const tsxPath = basePath.slice(0, -3) + '.tsx';
    if (knownSet.has(tsxPath)) return tsxPath;
  }

  if (basePath.endsWith('.jsx')) {
    const tsxPath = basePath.slice(0, -4) + '.tsx';
    if (knownSet.has(tsxPath)) return tsxPath;
  }

  // Try extension candidates
  for (const ext of EXTENSION_CANDIDATES) {
    const candidate = basePath + ext;
    if (knownSet.has(candidate)) {
      return candidate;
    }
  }

  return normalizePath(basePath);
}

function isKnownFile(path: string, knownFiles: ReadonlySet<string> | readonly string[]): boolean {
  const norm = normalizePath(path);
  if ('has' in knownFiles && typeof knownFiles.has === 'function') {
    return (knownFiles as ReadonlySet<string>).has(norm);
  }
  return (knownFiles as readonly string[]).includes(norm);
}

function toSet(knownFiles: ReadonlySet<string> | readonly string[]): ReadonlySet<string> {
  if (knownFiles instanceof Set) return knownFiles;
  return new Set((knownFiles as readonly string[]).map(normalizePath));
}
