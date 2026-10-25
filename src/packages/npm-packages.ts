import { posix } from 'node:path';
import { normalizePath } from '../path-utils.js';
import type { PackageNode } from '../types.js';
import { globToRegExp } from './glob.js';
import { satisfiesRange } from './npm-range.js';
import { packageDirOf, repoPath } from './paths.js';

/** A `packageRoot` fact: an entry file of an npm package (V3 Phase 7.5). */
export interface NpmPackageRoot {
  readonly packageId: string;
  readonly file: string;
}

/** A `dependsOn` edge between two workspace packages (V3 Phase 7.5). */
export interface NpmPackageDependency {
  readonly from: string;
  readonly to: string;
  readonly kind: 'normal' | 'dev' | 'peer' | 'optional';
  /** The dependency key, which is the name of the workspace package it links to */
  readonly name: string;
  /** Repository-relative path of the manifest that declares the dependency */
  readonly manifest: string;
}

export interface NpmManifestProblem {
  readonly path: string;
  readonly message: string;
}

/** What the npm manifests in a repository declare, before edges are drawn. */
export interface NpmPackageDiscovery {
  /** Sorted by id: one node per named `package.json` */
  readonly packages: readonly PackageNode[];
  /** Sorted by package id, then file */
  readonly packageRoots: readonly NpmPackageRoot[];
  /** Sorted by from, then to, kind and name */
  readonly dependencies: readonly NpmPackageDependency[];
  readonly problems: readonly NpmManifestProblem[];
}

type Json = Record<string, unknown>;

interface ParsedManifest {
  readonly path: string;
  readonly dir: string;
  readonly json: Json;
  readonly name?: string;
  readonly version?: string;
  /** The `workspaces` globs, when the manifest declares a workspace root */
  readonly workspaces?: readonly string[];
}

interface WorkspacePackage {
  readonly dir: string;
  readonly version?: string;
}

const DEPENDENCY_TABLES = [
  ['dependencies', 'normal'],
  ['devDependencies', 'dev'],
  ['peerDependencies', 'peer'],
  ['optionalDependencies', 'optional'],
] as const;

/**
 * Discovers the npm packages in a repository (V3 Phase 7.5). Every named `package.json` outside
 * `node_modules` yields one package node. Its entries come from `main`, `bin` and `exports`.
 * Dependencies link to workspace packages, either through the `workspace:` protocol or when a
 * version range is satisfied by the workspace package's version.
 *
 * @param filePaths every repository file, with `/` separators
 * @param readText reads a manifest's contents by repository-relative path
 * @param exists whether a path exists on disk. An entry that exists but was not scanned (for
 *   example under `dist/`, which the scan skips) is neither a root nor a problem.
 */
export function discoverNpmPackages(
  filePaths: readonly string[],
  readText: (path: string) => string,
  exists: (path: string) => boolean = () => false,
): NpmPackageDiscovery {
  const files = new Set(filePaths.map(normalizePath));
  const problems: NpmManifestProblem[] = [];
  const manifests = new Map<string, ParsedManifest>();
  for (const path of [...files].sort(compareText)) {
    if (posix.basename(path) !== 'package.json' || path.split('/').includes('node_modules')) {
      continue;
    }
    const parsed = parseManifest(path, readText(path), problems);
    if (parsed !== undefined) manifests.set(packageDirOf(path), parsed);
  }
  const dirs = [...manifests.keys()].sort(compareText);

  const workspaces = new Map<string, ReadonlySet<string>>();
  for (const dir of dirs) {
    const manifest = manifests.get(dir);
    if (manifest?.workspaces === undefined) continue;
    workspaces.set(dir, expandWorkspaces(manifest, dirs, problems));
  }

  const packages: PackageNode[] = [];
  const packageRoots: NpmPackageRoot[] = [];
  for (const dir of dirs) {
    const manifest = manifests.get(dir);
    if (manifest === undefined || manifest.name === undefined) continue;
    const id = packageIdOf(dir);
    const roots = entryFiles(manifest, files, exists, problems);
    packages.push({
      kind: 'package',
      id,
      ecosystem: 'npm',
      name: manifest.name,
      manifest: manifest.path,
      roots,
    });
    for (const file of roots) packageRoots.push({ packageId: id, file });
  }

  const dependencies = resolveDependencies(dirs, manifests, workspaces, problems);
  packages.sort((a, b) => compareText(a.id, b.id));
  packageRoots.sort((a, b) => compareText(a.packageId, b.packageId) || compareText(a.file, b.file));
  return { packages, packageRoots, dependencies, problems };
}

function parseManifest(
  path: string,
  text: string,
  problems: NpmManifestProblem[],
): ParsedManifest | undefined {
  let json: unknown;
  try {
    // npm accepts a leading byte-order mark; JSON.parse does not.
    json = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    problems.push({ path, message: `package.json is not valid JSON: ${reason}` });
    return undefined;
  }
  if (!isRecord(json)) {
    problems.push({ path, message: 'package.json must contain an object' });
    return undefined;
  }
  return {
    path,
    dir: packageDirOf(path),
    json,
    name: nonEmptyString(json.name),
    version: nonEmptyString(json.version),
    workspaces: workspaceGlobs(json.workspaces, path, problems),
  };
}

/** `workspaces` is an array of globs, or an object with a `packages` array (the Yarn 1 form). */
function workspaceGlobs(
  value: unknown,
  path: string,
  problems: NpmManifestProblem[],
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const list = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.packages)
      ? value.packages
      : undefined;
  if (list === undefined) {
    problems.push({ path, message: 'workspaces must be an array of package globs' });
    return undefined;
  }
  return list.filter((item): item is string => typeof item === 'string');
}

/**
 * The directories a workspace root covers: its own directory, every directory its globs match,
 * minus those matched by a `!` negation. A glob that matches no package directory is reported.
 */
function expandWorkspaces(
  manifest: ParsedManifest,
  dirs: readonly string[],
  problems: NpmManifestProblem[],
): ReadonlySet<string> {
  const members = new Set<string>([manifest.dir]);
  for (const raw of manifest.workspaces ?? []) {
    const negated = raw.startsWith('!');
    const pattern = raw.replace(/^!/, '').replace(/^\.\//, '').replace(/\/+$/, '');
    const regexp = globToRegExp(repoPath(manifest.dir, pattern));
    const matched = dirs.filter((dir) => regexp.test(dir));
    if (matched.length === 0 && !negated) {
      problems.push({ path: manifest.path, message: `workspace "${raw}" matches no package` });
    }
    for (const dir of matched) {
      if (negated) members.delete(dir);
      else members.add(dir);
    }
  }
  return members;
}

/**
 * The workspace a package belongs to: the nearest ancestor-or-self root that lists it, or the
 * first root in path order when none is an ancestor. A package outside every workspace has none.
 */
function workspaceRootOf(
  dir: string,
  workspaces: ReadonlyMap<string, ReadonlySet<string>>,
): string | undefined {
  const containing = [...workspaces.keys()]
    .filter((root) => workspaces.get(root)?.has(dir) === true)
    .sort(compareText);
  if (containing.length === 0) return undefined;
  for (let current = dir; ; current = posix.dirname(current)) {
    if (containing.includes(current)) return current;
    if (current === '.') break;
  }
  return containing[0];
}

/** The entry files of a package: `main`, `bin` and `exports`. Entries that do not exist are reported. */
function entryFiles(
  manifest: ParsedManifest,
  files: ReadonlySet<string>,
  exists: (path: string) => boolean,
  problems: NpmManifestProblem[],
): string[] {
  const dir = manifest.dir;
  const found = new Set<string>();
  const report = (field: string, value: string): void => {
    problems.push({
      path: manifest.path,
      message: `${field} entry "${value}" has no source file`,
    });
  };

  const main = manifest.json.main;
  if (typeof main === 'string') {
    const candidates = mainCandidates(dir, main);
    const file = candidates.find((path) => files.has(path));
    if (file !== undefined) found.add(file);
    else if (!candidates.some((path) => exists(path))) report('main', main);
  }

  const bin = manifest.json.bin;
  const binValues = typeof bin === 'string' ? [bin] : isRecord(bin) ? Object.values(bin) : [];
  for (const value of binValues) {
    if (typeof value !== 'string') continue;
    const path = repoPath(dir, value);
    if (files.has(path)) found.add(path);
    else if (!exists(path)) report('bin', value);
  }

  for (const value of exportTargets(manifest.json.exports)) {
    if (!value.startsWith('./')) continue;
    if (value.includes('*')) {
      const pattern = repoPath(dir, value);
      const regexp = globToRegExp(pattern);
      const matches = [...files].filter((file) => regexp.test(file));
      // A pattern under a directory that exists on disk may match unscanned files, so it is not reported.
      const prefix = pattern.slice(0, pattern.indexOf('*'));
      const prefixDir = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : '.';
      const unscanned = prefixDir !== '.' && exists(prefixDir);
      if (matches.length === 0 && !unscanned) report('exports', value);
      for (const file of matches) found.add(file);
      continue;
    }
    const path = repoPath(dir, value);
    if (files.has(path)) found.add(path);
    else if (!exists(path)) report('exports', value);
  }

  return [...found].sort(compareText);
}

/** The files `main` may name, as Node resolves it: the path, the path with an extension, or an index. */
function mainCandidates(dir: string, main: string): string[] {
  const base = repoPath(dir, main);
  return [
    base,
    `${base}.js`,
    `${base}.json`,
    `${base}.node`,
    posix.join(base, 'index.js'),
    posix.join(base, 'index.json'),
  ];
}

/** Every string in an `exports` value, whether a path, a conditions object or a fallback array. */
function exportTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(exportTargets);
  if (isRecord(value)) return Object.values(value).flatMap(exportTargets);
  return [];
}

function resolveDependencies(
  dirs: readonly string[],
  manifests: ReadonlyMap<string, ParsedManifest>,
  workspaces: ReadonlyMap<string, ReadonlySet<string>>,
  problems: NpmManifestProblem[],
): NpmPackageDependency[] {
  // Each workspace root's named packages, keyed by name. The first one in path order wins.
  const byRoot = new Map<string, ReadonlyMap<string, WorkspacePackage>>();
  for (const [root, members] of workspaces) {
    const named = new Map<string, WorkspacePackage>();
    for (const dir of [...members].sort(compareText)) {
      const manifest = manifests.get(dir);
      if (manifest === undefined || manifest.name === undefined) continue;
      if (named.has(manifest.name)) continue;
      named.set(manifest.name, { dir, version: manifest.version });
    }
    byRoot.set(root, named);
  }

  const edges = new Map<string, NpmPackageDependency>();
  for (const dir of dirs) {
    const manifest = manifests.get(dir);
    if (manifest === undefined || manifest.name === undefined) continue;
    const root = workspaceRootOf(dir, workspaces);
    if (root === undefined) continue;
    const named = byRoot.get(root);

    for (const [table, kind] of DEPENDENCY_TABLES) {
      const declared = manifest.json[table];
      if (!isRecord(declared)) continue;
      for (const [key, spec] of Object.entries(declared)) {
        if (typeof spec !== 'string') continue;
        const isWorkspaceSpec = spec.startsWith('workspace:');
        const target = named?.get(key);
        if (target === undefined) {
          if (isWorkspaceSpec) {
            problems.push({
              path: manifest.path,
              message: `dependency "${key}" uses the workspace protocol but no workspace package is named "${key}"`,
            });
          }
          continue;
        }
        if (target.dir === dir) continue;

        let linked: boolean | undefined = true;
        if (!isWorkspaceSpec) {
          linked = target.version === undefined ? undefined : satisfiesRange(target.version, spec);
        }
        if (linked === undefined) {
          problems.push({
            path: manifest.path,
            message: `dependency "${key}" range "${spec}" cannot be checked against workspace package "${key}"`,
          });
          continue;
        }
        if (!linked) continue;

        const from = packageIdOf(dir);
        const to = packageIdOf(target.dir);
        const id = `${from}\0${to}\0${kind}\0${key}`;
        if (!edges.has(id)) {
          edges.set(id, { from, to, kind, name: key, manifest: manifest.path });
        }
      }
    }
  }

  return [...edges.values()].sort(
    (a, b) =>
      compareText(a.from, b.from) ||
      compareText(a.to, b.to) ||
      compareText(a.kind, b.kind) ||
      compareText(a.name, b.name),
  );
}

function packageIdOf(dir: string): string {
  return `package:npm:${dir}`;
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
