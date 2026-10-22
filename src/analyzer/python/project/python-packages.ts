import { parse as parseToml } from 'smol-toml';
import { globToRegExp } from '../../../packages/glob.js';
import { normalizePath } from '../../../path-utils.js';
import type { PackageNode } from '../../../types.js';
import { dirOf, joinRepoPath } from './paths.js';
import { listValue, parseSetupCfg, type IniSection } from './setup-cfg.js';
import { readSetupPy } from './setup-py.js';

/** A manifest that cannot be read or understood. Problems are data here; Phase 5 reports them. */
export interface ManifestProblem {
  readonly path: string;
  readonly message: string;
}

/** A console script or entry point, before its target is resolved (V3 Phase 4.5). */
export interface PythonEntryPointDeclaration {
  readonly kind: 'script' | 'entry-point';
  /** The manifest that declares it */
  readonly manifest: string;
  /** The script node for a `script`, or the distribution for an `entry-point` */
  readonly packageId: string;
  /** The entry point group, for an `entry-point` */
  readonly group?: string;
  readonly name: string;
  /** `module:attribute` as written, which may carry extras such as `[extra]` */
  readonly target: string;
}

export type PythonDependencyKind = 'normal' | 'dev' | 'build' | 'optional';

/** An internal dependency between two Python distributions (V3 Phase 4.1, `dependsOn`). */
export interface PythonPackageDependency {
  /** The depending distribution's `lib` package id */
  readonly from: string;
  /** The distribution it depends on, also a `lib` package id */
  readonly to: string;
  readonly kind: PythonDependencyKind;
  /** The normalized dependency name */
  readonly name: string;
  readonly manifest: string;
}

export interface PythonPackageDiscovery {
  /** Sorted by id. A `lib` node per distribution, then its `script` nodes. */
  readonly packages: readonly PackageNode[];
  /** Sorted by package id, then kind, group and name */
  readonly entryPoints: readonly PythonEntryPointDeclaration[];
  /** Sorted by source, target, kind and name, with each edge once */
  readonly dependencies: readonly PythonPackageDependency[];
  readonly problems: readonly ManifestProblem[];
}

interface NamedTarget {
  readonly name: string;
  readonly target: string;
}

interface GroupedTarget extends NamedTarget {
  readonly group: string;
}

/**
 * A dependency as a manifest declares it. `path` is relative to the manifest directory, and is
 * absent for a dependency that is not inside the repository.
 */
interface DeclaredDependency {
  readonly kind: PythonDependencyKind;
  readonly name: string;
  readonly path?: string;
  readonly workspace: boolean;
}

/** What one manifest declares. Roots are repository-relative directories, sorted and unique. */
interface ManifestFacts {
  readonly name?: string;
  readonly roots: readonly string[];
  readonly scripts: readonly NamedTarget[];
  readonly entryPoints: readonly GroupedTarget[];
  readonly dependencies: readonly DeclaredDependency[];
}

/** A uv workspace root: the globs its `members` select, and the `exclude` globs (V3 Phase 4.1). */
interface UvWorkspace {
  readonly dir: string;
  readonly manifest: string;
  readonly members: readonly string[];
  readonly exclude: readonly string[];
}

type Table = Record<string, unknown>;

/**
 * Discover Python distributions from `pyproject.toml`, `setup.cfg` and `setup.py` (V3 Phases 4.1
 * and 4.5).
 *
 * A directory with a manifest yields one `lib` package node, with the import root directories it
 * declares as `roots`. Each `[project.scripts]` entry adds a `script` node, and each
 * `[project.entry-points]` entry is an `entry-point` declaration. Targets are resolved in Phase 4.5.
 *
 * Within one directory, `pyproject.toml` comes first. `setup.cfg` and then `setup.py` fill in what it
 * leaves unset. Only `pyproject.toml` declares scripts, entry points and dependencies.
 *
 * A `pyproject.toml` that cannot be parsed yields a problem and no packages for that directory. A
 * `pyproject.toml` that only configures tools (for example ruff) yields nothing and no problem.
 *
 * A dependency on a path inside the repository, or a uv `workspace = true` source, becomes a
 * `dependsOn` edge to that distribution. A path outside the repository is ignored.
 *
 * `readText` receives a repository-relative path that is already normalized to forward slashes.
 */
export function discoverPythonPackages(
  filePaths: readonly string[],
  readText: (path: string) => string,
): PythonPackageDiscovery {
  const groups = new Map<string, { pyproject?: string; setupCfg?: string; setupPy?: string }>();
  for (const raw of filePaths) {
    const path = normalizePath(raw);
    const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
    if (base !== 'pyproject.toml' && base !== 'setup.cfg' && base !== 'setup.py') continue;
    const dir = dirOf(path);
    const group = groups.get(dir) ?? {};
    if (base === 'pyproject.toml') group.pyproject = path;
    else if (base === 'setup.cfg') group.setupCfg = path;
    else group.setupPy = path;
    groups.set(dir, group);
  }

  const packages: PackageNode[] = [];
  const entryPoints: PythonEntryPointDeclaration[] = [];
  const problems: ManifestProblem[] = [];
  const declared: Array<{
    id: string;
    dir: string;
    manifest: string;
    dependencies: readonly DeclaredDependency[];
  }> = [];
  const uvWorkspaces = new Map<string, UvWorkspace>();
  for (const dir of [...groups.keys()].sort()) {
    const group = groups.get(dir);
    if (!group) continue;
    const facts = readGroup(dir, group, readText, problems, uvWorkspaces);
    if (!facts) continue;

    const manifest = group.pyproject ?? group.setupCfg ?? group.setupPy ?? dir;
    if (facts.name === undefined) {
      if (facts.roots.length > 0 || facts.scripts.length > 0 || facts.entryPoints.length > 0) {
        problems.push({ path: manifest, message: 'declares package roots or scripts but no name' });
      }
      continue;
    }

    const id = `package:python:${dir}`;
    packages.push({
      kind: 'package',
      id,
      ecosystem: 'python',
      name: facts.name,
      target: 'lib',
      manifest,
      roots: [...facts.roots],
    });
    declared.push({ id, dir, manifest, dependencies: facts.dependencies });
    for (const script of [...facts.scripts].sort((a, b) => compare(a.name, b.name))) {
      const scriptId = `${id}#script:${script.name}`;
      packages.push({
        kind: 'package',
        id: scriptId,
        ecosystem: 'python',
        name: script.name,
        target: 'script',
        manifest,
        roots: [],
      });
      entryPoints.push({
        kind: 'script',
        manifest,
        packageId: scriptId,
        name: script.name,
        target: script.target,
      });
    }
    for (const entry of facts.entryPoints) {
      entryPoints.push({
        kind: 'entry-point',
        manifest,
        packageId: id,
        group: entry.group,
        name: entry.name,
        target: entry.target,
      });
    }
  }

  const dependencies = resolveDependencies(packages, declared, uvWorkspaces, problems);
  packages.sort((a, b) => compare(a.id, b.id));
  entryPoints.sort(
    (a, b) =>
      compare(a.packageId, b.packageId) ||
      compare(a.kind, b.kind) ||
      compare(a.group ?? '', b.group ?? '') ||
      compare(a.name, b.name),
  );
  return { packages, entryPoints, dependencies, problems };
}

/** Turn declared dependencies into `dependsOn` edges between discovered distributions. */
function resolveDependencies(
  packages: readonly PackageNode[],
  declared: ReadonlyArray<{
    id: string;
    dir: string;
    manifest: string;
    dependencies: readonly DeclaredDependency[];
  }>,
  uvWorkspaces: ReadonlyMap<string, UvWorkspace>,
  problems: ManifestProblem[],
): PythonPackageDependency[] {
  const libByDir = new Map<string, string>();
  const libByName = new Map<string, string>();
  for (const node of packages) {
    if (node.target !== 'lib') continue;
    const dir = node.id.slice('package:python:'.length);
    libByDir.set(dir, node.id);
    const key = normalizeName(node.name);
    if (!libByName.has(key)) libByName.set(key, node.id);
  }

  const edges = new Map<string, PythonPackageDependency>();
  for (const source of declared) {
    for (const dependency of source.dependencies) {
      if (dependency.path === undefined && !dependency.workspace) continue;
      let to: string | undefined;
      if (dependency.path !== undefined) {
        const targetDir = joinRepoPath(source.dir, dependency.path);
        to = libByDir.get(targetDir);
        if (!to) {
          problems.push({
            path: source.manifest,
            message: `dependency "${dependency.name}" path "${dependency.path}" names no package`,
          });
          continue;
        }
      } else {
        to = libByName.get(dependency.name);
        if (!to) {
          problems.push({
            path: source.manifest,
            message: `workspace dependency "${dependency.name}" names no package`,
          });
          continue;
        }
      }
      if (dependency.path === undefined) {
        // A `workspace = true` source must name a member of the uv workspace that encloses it.
        const workspace = enclosingUvWorkspace(source.dir, uvWorkspaces);
        const targetDir = to.slice('package:python:'.length);
        if (workspace !== undefined && !isUvMember(workspace, targetDir)) {
          problems.push({
            path: source.manifest,
            message: `workspace dependency "${dependency.name}" is not a member of the uv workspace declared in ${workspace.manifest}`,
          });
          continue;
        }
      }
      if (to === source.id) continue;
      const key = `${source.id}\u0000${to}\u0000${dependency.kind}\u0000${dependency.name}`;
      edges.set(key, {
        from: source.id,
        to,
        kind: dependency.kind,
        name: dependency.name,
        manifest: source.manifest,
      });
    }
  }
  return [...edges.values()].sort(
    (a, b) =>
      compare(a.from, b.from) ||
      compare(a.to, b.to) ||
      compare(a.kind, b.kind) ||
      compare(a.name, b.name),
  );
}

function readGroup(
  dir: string,
  group: { pyproject?: string; setupCfg?: string; setupPy?: string },
  readText: (path: string) => string,
  problems: ManifestProblem[],
  uvWorkspaces: Map<string, UvWorkspace>,
): ManifestFacts | undefined {
  let pyproject: ManifestFacts | undefined;
  let setupCfg: ManifestFacts | undefined;
  let setupPy: ManifestFacts | undefined;

  if (group.pyproject) {
    try {
      const doc = parseToml(readText(group.pyproject)) as Table;
      pyproject = pyprojectFacts(dir, doc);
      const workspace = parseUvWorkspace(dir, group.pyproject, doc);
      if (workspace !== undefined) uvWorkspaces.set(dir, workspace);
    } catch (error) {
      problems.push({ path: group.pyproject, message: `cannot parse: ${describe(error)}` });
      return undefined;
    }
  }
  if (group.setupCfg) {
    const parsed = parseSetupCfg(readText(group.setupCfg));
    for (const error of parsed.errors) {
      problems.push({ path: group.setupCfg, message: `line ${error.line}: ${error.message}` });
    }
    setupCfg = setupCfgFacts(dir, parsed.sections);
  }
  if (group.setupPy) {
    const parsed = readSetupPy(dir, readText(group.setupPy));
    for (const note of parsed.notes) {
      problems.push({ path: group.setupPy, message: `line ${note.line}: ${note.message}` });
    }
    setupPy = {
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      roots: parsed.roots,
      scripts: [],
      entryPoints: [],
      dependencies: [],
    };
  }

  const sources = [pyproject, setupCfg, setupPy];
  if (!sources.some((facts) => facts !== undefined)) return undefined;
  return {
    name: sources.find((facts) => facts?.name !== undefined)?.name,
    roots: sources.find((facts) => (facts?.roots.length ?? 0) > 0)?.roots ?? [],
    scripts: pyproject?.scripts ?? [],
    entryPoints: pyproject?.entryPoints ?? [],
    dependencies: pyproject?.dependencies ?? [],
  };
}

/** Read the package layout, entry points and dependencies a pyproject.toml declares. */
function pyprojectFacts(dir: string, doc: Table): ManifestFacts {
  const roots: string[] = [];
  const add = (relative: string | undefined): void => {
    if (relative !== undefined) roots.push(joinRepoPath(dir, relative));
  };

  // setuptools: package-dir = {"" = "src"}, and packages.find where = [...]. A find table with no
  // `where` searches the directory itself.
  add(text(dig(doc, 'tool', 'setuptools', 'package-dir', '')));
  const find = table(dig(doc, 'tool', 'setuptools', 'packages', 'find'));
  if (find) {
    const where = find.where === undefined ? ['.'] : stringList(find.where);
    for (const entry of where) add(entry);
  }

  // Poetry: packages = [{ include = "pkg", from = "src" }]. `from` defaults to the project root.
  const poetryPackages = dig(doc, 'tool', 'poetry', 'packages');
  if (Array.isArray(poetryPackages)) {
    for (const entry of poetryPackages) add(text(table(entry)?.from) ?? '.');
  }

  // Hatch: wheel packages are paths such as "src/pkg". The import root is the parent directory.
  for (const entry of stringList(
    dig(doc, 'tool', 'hatch', 'build', 'targets', 'wheel', 'packages'),
  )) {
    add(dirOf(entry));
  }

  // PDM and maturin each name the source directory directly.
  add(text(dig(doc, 'tool', 'pdm', 'build', 'package-dir')));
  add(text(dig(doc, 'tool', 'maturin', 'python-source')));

  return {
    name: text(dig(doc, 'project', 'name')) ?? text(dig(doc, 'tool', 'poetry', 'name')),
    roots: unique(roots),
    scripts: stringEntries(table(dig(doc, 'project', 'scripts'))).map(([name, target]) => ({
      name,
      target,
    })),
    entryPoints: groupedEntries(table(dig(doc, 'project', 'entry-points'))),
    dependencies: collectDependencies(doc),
  };
}

/**
 * Every dependency the pyproject declares, in the forms the Phase 4.1 tools use: PEP 508 strings
 * (with `name @ file:` and `-e file:` path forms), Poetry tables, and the uv `tool.uv.sources`
 * table, which gives a path or `workspace = true` to a declared name.
 */
function collectDependencies(doc: Table): DeclaredDependency[] {
  const out: Array<{
    kind: PythonDependencyKind;
    name: string;
    path?: string;
    workspace: boolean;
  }> = [];

  const addRequirements = (kind: PythonDependencyKind, value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (typeof entry !== 'string') continue;
      const name = requirementName(entry);
      if (name === undefined) continue;
      const path = fileReference(entry);
      out.push({ kind, name, ...(path !== undefined ? { path } : {}), workspace: false });
    }
  };
  const addTables = (kind: PythonDependencyKind, value: unknown): void => {
    for (const [name, spec] of Object.entries(table(value) ?? {})) {
      if (normalizeName(name) === 'python') continue;
      const entry = table(spec);
      const path = pathValue(entry?.path);
      const optional = entry?.optional === true;
      out.push({
        kind: kind === 'normal' && optional ? 'optional' : kind,
        name: normalizeName(name),
        ...(path !== undefined ? { path } : {}),
        workspace: entry?.workspace === true,
      });
    }
  };
  const addGroups = (kind: PythonDependencyKind, value: unknown): void => {
    for (const group of Object.values(table(value) ?? {})) addRequirements(kind, group);
  };

  addRequirements('normal', dig(doc, 'project', 'dependencies'));
  addGroups('optional', dig(doc, 'project', 'optional-dependencies'));
  addGroups('dev', dig(doc, 'dependency-groups'));
  addRequirements('build', dig(doc, 'build-system', 'requires'));
  addRequirements('dev', dig(doc, 'tool', 'uv', 'dev-dependencies'));
  addGroups('dev', dig(doc, 'tool', 'pdm', 'dev-dependencies'));
  addTables('normal', dig(doc, 'tool', 'poetry', 'dependencies'));
  addTables('dev', dig(doc, 'tool', 'poetry', 'dev-dependencies'));
  for (const group of Object.values(table(dig(doc, 'tool', 'poetry', 'group')) ?? {})) {
    addTables('dev', table(group)?.dependencies);
  }

  // A uv source gives a path or workspace to the dependency of the same name, whatever its kind.
  const sources = new Map<string, Table>();
  for (const [name, spec] of Object.entries(table(dig(doc, 'tool', 'uv', 'sources')) ?? {})) {
    const source = table(spec);
    if (source) sources.set(normalizeName(name), source);
  }
  return out.map((dependency) => {
    const source = sources.get(dependency.name);
    if (!source || dependency.path !== undefined || dependency.workspace) return dependency;
    const path = pathValue(source.path);
    return {
      ...dependency,
      ...(path !== undefined ? { path } : {}),
      workspace: source.workspace === true,
    };
  });
}

/** The PEP 503 normalized name of a requirement string, such as `Demo_Pkg[extra]>=1`. */
function requirementName(spec: string): string | undefined {
  const egg = /#egg=([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec);
  if (spec.trimStart().startsWith('-e') && egg?.[1]) return normalizeName(egg[1]);
  const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec);
  return match?.[1] ? normalizeName(match[1]) : undefined;
}

/**
 * The repository-relative path of a `file:` reference, with `${PROJECT_ROOT}` standing for the
 * manifest directory. An absolute path is outside the repository, so it has no path here.
 */
function fileReference(spec: string): string | undefined {
  const match = /\bfile:(\/\/)?([^\s;#]+)/.exec(spec);
  if (!match) return undefined;
  let rest = match[2] ?? '';
  // "/${PROJECT_ROOT}/x" after file:// is the project root, not an absolute path.
  if (rest.startsWith('/${PROJECT_ROOT}')) rest = rest.slice(1);
  if (rest.startsWith('${PROJECT_ROOT}')) {
    return rest.slice('${PROJECT_ROOT}'.length).replace(/^\//, '') || '.';
  }
  if (rest.startsWith('/')) return undefined;
  return rest || '.';
}

/** A path value from a manifest, when it is repository-relative. */
function pathValue(value: unknown): string | undefined {
  const path = text(value);
  if (path === undefined || isAbsolutePath(path)) return undefined;
  return path;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path);
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/** Read the layout a setup.cfg declares: package_dir and packages.find where. */
function setupCfgFacts(dir: string, sections: ReadonlyMap<string, IniSection>): ManifestFacts {
  const roots: string[] = [];
  const add = (relative: string): void => {
    roots.push(joinRepoPath(dir, relative));
  };

  // package_dir takes a mapping. The entry with an empty key is the root, written as `=src`.
  const packageDirValue = sections.get('options')?.get('package_dir');
  for (const line of (packageDirValue ?? '').split('\n')) {
    const mapping = /^([^=]*)=(.*)$/.exec(line.trim());
    if (mapping && (mapping[1] ?? '').trim() === '') add((mapping[2] ?? '').trim() || '.');
  }

  for (const sectionName of ['options.packages.find', 'options.packages.find_namespace']) {
    const section = sections.get(sectionName);
    if (!section) continue;
    const where = listValue(section.get('where'));
    for (const entry of where.length > 0 ? where : ['.']) add(entry);
  }

  const name = sections.get('metadata')?.get('name');
  return {
    name: name && name !== '' ? name : undefined,
    roots: unique(roots),
    scripts: [],
    entryPoints: [],
    dependencies: [],
  };
}

/** The `[key, value]` pairs of a table whose values are strings. */
function stringEntries(value: Table | undefined): Array<[string, string]> {
  if (!value) return [];
  return Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
}

/** The entries of `[project.entry-points]`: a table of groups, each a table of name = target. */
function groupedEntries(value: Table | undefined): GroupedTarget[] {
  if (!value) return [];
  const out: GroupedTarget[] = [];
  for (const [group, groupValue] of Object.entries(value)) {
    for (const [name, target] of stringEntries(table(groupValue))) {
      out.push({ group, name, target });
    }
  }
  return out;
}

/** The value at a path of keys, or undefined when any step is not a table. */
function dig(value: unknown, ...keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    const t = table(current);
    if (!t) return undefined;
    current = t[key];
  }
  return current;
}

function table(value: unknown): Table | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Table)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** A TOML string or array of strings, as a list. Other values give an empty list. */
function stringList(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
  return [];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compare);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The `[tool.uv.workspace]` table of a pyproject, when it has one. */
function parseUvWorkspace(dir: string, manifest: string, doc: Table): UvWorkspace | undefined {
  const workspace = table(dig(doc, 'tool', 'uv', 'workspace'));
  if (workspace === undefined) return undefined;
  return {
    dir,
    manifest,
    members: stringItems(workspace.members),
    exclude: stringItems(workspace.exclude),
  };
}

/** The nearest uv workspace root at or above `dir`. That root decides who may be a member. */
function enclosingUvWorkspace(
  dir: string,
  workspaces: ReadonlyMap<string, UvWorkspace>,
): UvWorkspace | undefined {
  let current = dir;
  for (;;) {
    const found = workspaces.get(current);
    if (found !== undefined) return found;
    const parent = dirOf(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Whether a project directory is the workspace root or matches a `members` glob and no `exclude`. */
function isUvMember(workspace: UvWorkspace, dir: string): boolean {
  if (dir === workspace.dir) return true;
  const matches = (globs: readonly string[]): boolean =>
    globs.some((glob) =>
      globToRegExp(joinRepoPath(workspace.dir, glob.replace(/\/+$/, ''))).test(dir),
    );
  return matches(workspace.members) && !matches(workspace.exclude);
}

function stringItems(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
