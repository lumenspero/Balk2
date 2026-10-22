import { normalizePath } from '../../../path-utils.js';

/** A module file: `pkg/mod.py`, or `pkg/mod.pyi` when only the stub exists. */
export interface ModuleFile {
  readonly kind: 'module';
  readonly name: string;
  /** The file imports point at. This is the `.py` when one exists, otherwise the `.pyi`. */
  readonly file: string;
  readonly stubOnly: boolean;
}

/** A regular package: a directory with an `__init__` file. */
export interface RegularPackage {
  readonly kind: 'package';
  readonly name: string;
  readonly dir: string;
  readonly init: string;
  readonly stubOnly: boolean;
}

/** A PEP 420 namespace package: directories with no `__init__`, found in one or more roots. */
export interface NamespacePackage {
  readonly kind: 'namespace';
  readonly name: string;
  readonly dirs: readonly string[];
}

export type ModuleEntry = ModuleFile | RegularPackage | NamespacePackage;

/** A module file that a regular package of the same name hides (V3 `shadowed-module`). */
export interface ShadowedModule {
  /** The hidden module file */
  readonly module: string;
  /** The package directory that hides it */
  readonly package: string;
}

export interface ModuleLookup {
  /** The entry for the whole dotted name, when it resolves */
  readonly entry?: ModuleEntry;
  /** Each entry on the way, outermost first. A lookup that fails part way keeps the prefix. */
  readonly chain: readonly ModuleEntry[];
  /** The index of the first segment that matched nothing */
  readonly missingAt?: number;
  readonly shadowed: readonly ShadowedModule[];
}

/**
 * The import system of a repository, over its scanned files (V3 Phase 4.3). A lookup follows
 * CPython's path finder: each segment is searched only inside the directories of its parent, and
 * within one directory a regular package beats a module of the same name. A namespace package is
 * used only when no entry in any searched directory is a regular package or module.
 */
export class ModuleIndex {
  private readonly files: ReadonlySet<string>;
  private readonly dirs: ReadonlySet<string>;

  constructor(filePaths: readonly string[]) {
    const files = new Set<string>();
    const dirs = new Set<string>(['.']);
    for (const raw of filePaths) {
      const file = normalizePath(raw);
      files.add(file);
      let dir = file;
      for (let slash = dir.lastIndexOf('/'); slash >= 0; slash = dir.lastIndexOf('/')) {
        dir = dir.slice(0, slash);
        dirs.add(dir);
      }
    }
    this.files = files;
    this.dirs = dirs;
  }

  hasDir(dir: string): boolean {
    return this.dirs.has(dir);
  }

  /** The entry for a directory used as a package, such as the package containing a file. */
  packageAt(dir: string): ModuleEntry | undefined {
    const init = this.initFile(dir);
    if (init) {
      return {
        kind: 'package',
        name: lastSegment(dir),
        dir,
        init: init.file,
        stubOnly: init.stubOnly,
      };
    }
    return this.dirs.has(dir)
      ? { kind: 'namespace', name: lastSegment(dir), dirs: [dir] }
      : undefined;
  }

  /** Look up a dotted name, starting from the directories in `topDirs`. */
  resolve(name: readonly string[], topDirs: readonly string[]): ModuleLookup {
    const chain: ModuleEntry[] = [];
    const shadowed: ShadowedModule[] = [];
    let dirs: readonly string[] = topDirs;
    for (let index = 0; index < name.length; index++) {
      const segment = name[index] ?? '';
      const found = this.findChild(dirs, segment);
      if (found.shadowed) shadowed.push(found.shadowed);
      const entry: ModuleEntry | undefined =
        found.entry ??
        (found.namespaceDirs.length > 0
          ? { kind: 'namespace', name: segment, dirs: found.namespaceDirs }
          : undefined);
      if (!entry) return { chain, missingAt: index, shadowed };
      chain.push(entry);
      if (index === name.length - 1) return { entry, chain, shadowed };
      if (entry.kind === 'module') return { chain, missingAt: index + 1, shadowed };
      dirs = entry.kind === 'package' ? [entry.dir] : entry.dirs;
    }
    return { chain, missingAt: 0, shadowed };
  }

  /** The children a package or namespace entry exposes to `from entry import name`. */
  childDirs(entry: ModuleEntry): readonly string[] {
    if (entry.kind === 'package') return [entry.dir];
    if (entry.kind === 'namespace') return entry.dirs;
    return [];
  }

  /** The `__init__` file of a directory, preferring `.py` over a `.pyi` stub. */
  initFile(dir: string): { file: string; stubOnly: boolean } | undefined {
    const py = joinPath(dir, '__init__.py');
    if (this.files.has(py)) return { file: py, stubOnly: false };
    const pyi = joinPath(dir, '__init__.pyi');
    if (this.files.has(pyi)) return { file: pyi, stubOnly: true };
    return undefined;
  }

  /** The module file `name` in `dir`, preferring `.py` over a `.pyi` stub. */
  private moduleFile(dir: string, name: string): { file: string; stubOnly: boolean } | undefined {
    const py = joinPath(dir, `${name}.py`);
    if (this.files.has(py)) return { file: py, stubOnly: false };
    const pyi = joinPath(dir, `${name}.pyi`);
    if (this.files.has(pyi)) return { file: pyi, stubOnly: true };
    return undefined;
  }

  private findChild(
    dirs: readonly string[],
    name: string,
  ): {
    entry?: ModuleFile | RegularPackage;
    namespaceDirs: string[];
    shadowed?: ShadowedModule;
  } {
    const namespaceDirs: string[] = [];
    for (const dir of dirs) {
      const child = joinPath(dir, name);
      const init = this.initFile(child);
      const module = this.moduleFile(dir, name);
      if (init) {
        const shadowed = module ? { module: module.file, package: child } : undefined;
        return {
          entry: { kind: 'package', name, dir: child, init: init.file, stubOnly: init.stubOnly },
          namespaceDirs,
          shadowed,
        };
      }
      if (module) {
        return {
          entry: { kind: 'module', name, file: module.file, stubOnly: module.stubOnly },
          namespaceDirs,
        };
      }
      if (this.dirs.has(child)) namespaceDirs.push(child);
    }
    return { namespaceDirs };
  }
}

function joinPath(dir: string, name: string): string {
  return dir === '.' ? name : `${dir}/${name}`;
}

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
