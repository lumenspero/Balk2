import { parse as parseToml } from 'smol-toml';
import { normalizePath } from '../../../path-utils.js';
import type { PackageNode } from '../../../types.js';
import { dirOf, joinRepoPath } from './paths.js';
import { listValue, parseSetupCfg, type IniSection } from './setup-cfg.js';

/** A manifest that cannot be read or understood. Problems are data here; Phase 5 reports them. */
export interface ManifestProblem {
  readonly path: string;
  readonly message: string;
}

export interface PythonPackageDiscovery {
  /** Sorted by id. A `lib` node per distribution, then its `script` nodes. */
  readonly packages: readonly PackageNode[];
  readonly problems: readonly ManifestProblem[];
}

/** What one manifest declares. Roots are repository-relative directories, sorted and unique. */
interface ManifestFacts {
  readonly name?: string;
  readonly roots: readonly string[];
  readonly scripts: readonly string[];
}

type Table = Record<string, unknown>;

/**
 * Discover Python distributions from `pyproject.toml` and `setup.cfg` (V3 Phase 4.1).
 *
 * A directory with a manifest yields one `lib` package node, with the import root directories it
 * declares as `roots`. Each `[project.scripts]` entry adds a `script` node. A `pyproject.toml`
 * that cannot be parsed yields a problem and no packages for that directory. A `pyproject.toml`
 * that only configures tools (for example ruff) yields nothing and no problem. `setup.cfg` fills
 * in whatever `pyproject.toml` leaves unset in the same directory.
 *
 * `readText` receives a repository-relative path that is already normalized to forward slashes.
 */
export function discoverPythonPackages(
  filePaths: readonly string[],
  readText: (path: string) => string,
): PythonPackageDiscovery {
  const groups = new Map<string, { pyproject?: string; setupCfg?: string }>();
  for (const raw of filePaths) {
    const path = normalizePath(raw);
    const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
    if (base !== 'pyproject.toml' && base !== 'setup.cfg') continue;
    const dir = dirOf(path);
    const group = groups.get(dir) ?? {};
    if (base === 'pyproject.toml') group.pyproject = path;
    else group.setupCfg = path;
    groups.set(dir, group);
  }

  const packages: PackageNode[] = [];
  const problems: ManifestProblem[] = [];
  for (const dir of [...groups.keys()].sort()) {
    const group = groups.get(dir);
    if (!group) continue;
    const facts = readGroup(dir, group, readText, problems);
    if (!facts) continue;

    const manifest = group.pyproject ?? group.setupCfg ?? dir;
    if (facts.name === undefined) {
      if (facts.roots.length > 0 || facts.scripts.length > 0) {
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
    for (const script of [...facts.scripts].sort()) {
      packages.push({
        kind: 'package',
        id: `${id}#script:${script}`,
        ecosystem: 'python',
        name: script,
        target: 'script',
        manifest,
        roots: [],
      });
    }
  }
  packages.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { packages, problems };
}

function readGroup(
  dir: string,
  group: { pyproject?: string; setupCfg?: string },
  readText: (path: string) => string,
  problems: ManifestProblem[],
): ManifestFacts | undefined {
  let pyproject: ManifestFacts | undefined;
  let setupCfg: ManifestFacts | undefined;

  if (group.pyproject) {
    try {
      const doc = parseToml(readText(group.pyproject)) as Table;
      pyproject = pyprojectFacts(dir, doc);
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

  if (!pyproject) return setupCfg;
  if (!setupCfg) return pyproject;
  return {
    name: pyproject.name ?? setupCfg.name,
    roots: pyproject.roots.length > 0 ? pyproject.roots : setupCfg.roots,
    scripts: pyproject.scripts,
  };
}

/** Read the package layout a pyproject.toml declares, for the build tools Phase 4.1 names. */
function pyprojectFacts(dir: string, doc: Table): ManifestFacts {
  const roots: string[] = [];
  const add = (relative: string | undefined): void => {
    if (relative !== undefined) roots.push(joinRepoPath(dir, relative));
  };

  // setuptools: package-dir = {"" = "src"}, and packages.find where = [...]. A find table with no
  // `where` searches the directory itself.
  const packageDir = dig(doc, 'tool', 'setuptools', 'package-dir', '');
  add(text(packageDir));
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
  const hatchPackages = dig(doc, 'tool', 'hatch', 'build', 'targets', 'wheel', 'packages');
  for (const entry of stringList(hatchPackages)) add(dirOf(entry));

  // PDM and maturin each name the source directory directly.
  add(text(dig(doc, 'tool', 'pdm', 'build', 'package-dir')));
  add(text(dig(doc, 'tool', 'maturin', 'python-source')));

  const scripts = table(dig(doc, 'project', 'scripts'));
  return {
    name: text(dig(doc, 'project', 'name')) ?? text(dig(doc, 'tool', 'poetry', 'name')),
    roots: unique(roots),
    scripts: scripts ? Object.keys(scripts) : [],
  };
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
  };
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
  return [...new Set(values)].sort();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
