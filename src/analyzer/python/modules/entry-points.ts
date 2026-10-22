import type { FactTarget } from '../../../facts/types.js';
import type { PackageNode } from '../../../types.js';
import type { ManifestProblem, PythonEntryPointDeclaration } from '../project/python-packages.js';
import { missingTarget } from './import-resolution.js';
import type { ModuleIndex, ModuleEntry } from './module-index.js';
import type { SymbolResolver } from './module-exports.js';

/** An entry point registered under a registry key (V3 Phase 4.5). */
export interface EntryPointRegistration {
  /** `registry:entry-points:<group>#<name>` */
  readonly registryKey: string;
  readonly manifest: string;
  readonly target: FactTarget;
}

/** A `packageRoot` fact: the file a script package runs. */
export interface PackageRootFact {
  readonly packageId: string;
  readonly file: string;
}

export interface EntryPointResolution {
  /** The same packages, with each script node's `roots` set to its module file */
  readonly packages: readonly PackageNode[];
  readonly packageRoots: readonly PackageRootFact[];
  readonly registrations: readonly EntryPointRegistration[];
  readonly problems: readonly ManifestProblem[];
}

export interface EntryPointInput {
  readonly packages: readonly PackageNode[];
  readonly declarations: readonly PythonEntryPointDeclaration[];
  readonly index: ModuleIndex;
  /** Import roots in precedence order, from Phase 4.2 */
  readonly roots: readonly string[];
  readonly symbols: SymbolResolver;
}

/** A `module:attribute` target, with any `[extra]` suffix removed. */
export interface EntryPointTarget {
  readonly module: string;
  readonly attribute?: string;
}

export function parseEntryPointTarget(text: string): EntryPointTarget | undefined {
  const bare = text.replace(/\s*\[[^\]]*\]\s*$/, '').trim();
  const match = /^([A-Za-z_][\w.]*)\s*(?::\s*([A-Za-z_][\w.]*))?$/.exec(bare);
  if (!match) return undefined;
  const module = match[1] ?? '';
  const attribute = match[2];
  return attribute !== undefined ? { module, attribute } : { module };
}

/**
 * Resolve script and entry-point targets to repository files and symbols (V3 Phase 4.5). A script
 * target gives the script node its module file as `roots`, and a `packageRoot` fact. An entry
 * point becomes a `registers` fact from `registry:entry-points:<group>#<name>` to its symbol. A
 * target outside the repository is recorded as external and does not fail. A target inside the
 * repository that does not resolve is reported as a problem.
 */
export function resolveEntryPoints(input: EntryPointInput): EntryPointResolution {
  const problems: ManifestProblem[] = [];
  const packageRoots: PackageRootFact[] = [];
  const registrations: EntryPointRegistration[] = [];
  const scriptRoots = new Map<string, string>();

  for (const declaration of input.declarations) {
    const label = `${declaration.kind === 'script' ? 'script' : 'entry point'} "${declaration.name}"`;
    const parsed = parseEntryPointTarget(declaration.target);
    if (!parsed) {
      problems.push({
        path: declaration.manifest,
        message: `${label} has an invalid target "${declaration.target}"`,
      });
      continue;
    }

    const parts = parsed.module.split('.');
    const lookup = input.index.resolve(parts, input.roots);
    let file: string | undefined;
    let target: FactTarget;
    if (!lookup.entry) {
      target = missingTarget(parsed.module, parts, input.index, input.roots);
    } else {
      file = entryFile(lookup.entry);
      if (!file) {
        target = { kind: 'unresolved', reason: 'unresolved-module-path', subject: parsed.module };
      } else if (parsed.attribute === undefined) {
        target = { kind: 'file', path: file };
      } else {
        target = input.symbols.resolveName(file, parsed.attribute);
      }
    }

    if (target.kind === 'unresolved') {
      problems.push({
        path: declaration.manifest,
        message: `${label} target "${declaration.target}" does not resolve`,
      });
    }
    if (declaration.kind === 'script') {
      if (file) {
        scriptRoots.set(declaration.packageId, file);
        packageRoots.push({ packageId: declaration.packageId, file });
      }
    } else {
      registrations.push({
        registryKey: `registry:entry-points:${declaration.group ?? ''}#${declaration.name}`,
        manifest: declaration.manifest,
        target,
      });
    }
  }

  const packages = input.packages.map((node) => {
    const file = scriptRoots.get(node.id);
    return file !== undefined ? { ...node, roots: [file] } : node;
  });
  packageRoots.sort((a, b) => compare(a.packageId, b.packageId));
  registrations.sort((a, b) => compare(a.registryKey, b.registryKey));
  return { packages, packageRoots, registrations, problems };
}

/** The file an import of an entry resolves to: a module file, or a package's `__init__`. */
function entryFile(entry: ModuleEntry): string | undefined {
  if (entry.kind === 'module') return entry.file;
  if (entry.kind === 'package') return entry.init;
  return undefined;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
