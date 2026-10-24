/**
 * Python dynamic module loads (Phase 12.5). Each load is read from the call observer. A literal
 * name becomes a `load` module-edge fact; any other name becomes a `dynamic-module-specifier` fact.
 * The module-load engine decides what each fact adds to the graph.
 *
 * - `importlib.import_module(name, package=None)` (`import-module`)
 * - `runpy.run_module(mod_name)` (`run-module`)
 * - `runpy.run_path(path_name)` (`run-path`)
 * - `importlib.util.spec_from_file_location(name, location)` (`spec-from-file`)
 * - `__import__(name, globals, locals, fromlist, level)` (`dunder-import`), when the builtin is meant
 */
import type { FactTarget, FileFacts, ModuleEdge } from '../../facts/types.js';
import { normalizePath } from '../../graph.js';
import type { LoadKind } from '../../types.js';
import type { Expr } from './ast.js';
import type { CallObserver, ObservedCall } from './calls.js';
import { dottedName } from './expression-format.js';
import { resolveBase, toSourceSpan } from './inheritance.js';
import type { ModuleIndex } from './modules/module-index.js';
import { argumentOf, literalName, qualifiedName, segmentsOf } from './call-names.js';
import type { ModuleBinding } from './state-facts.js';

export interface PythonLoadOptions {
  /** Per file, the names its imports bind, from the import resolver. */
  readonly bindings?: ReadonlyMap<string, ReadonlyMap<string, ModuleBinding>>;
  /** The repository's modules. */
  readonly index: ModuleIndex;
  /** The directories the module index is searched from. */
  readonly roots: readonly string[];
  /** The repository's files, as repository-relative paths. */
  readonly files: ReadonlySet<string>;
}

export interface PythonLoadCollector {
  readonly observer: CallObserver;
  facts(): ModuleEdge[];
}

/** A library function that loads a module, the loader it is read as, and where its name is written. */
interface LoadForm {
  readonly callee: string;
  readonly loadKind: LoadKind;
  readonly target: 'module' | 'path';
  readonly keyword: string;
  readonly position: number;
}

const LOAD_FORMS: readonly LoadForm[] = [
  {
    callee: 'importlib.import_module',
    loadKind: 'import-module',
    target: 'module',
    keyword: 'name',
    position: 0,
  },
  {
    callee: 'runpy.run_module',
    loadKind: 'run-module',
    target: 'module',
    keyword: 'mod_name',
    position: 0,
  },
  {
    callee: 'runpy.run_path',
    loadKind: 'run-path',
    target: 'path',
    keyword: 'path_name',
    position: 0,
  },
  {
    callee: 'importlib.util.spec_from_file_location',
    loadKind: 'spec-from-file',
    target: 'path',
    keyword: 'location',
    position: 1,
  },
];

const DUNDER_IMPORT = '__import__';

/**
 * One load call, read. `prefix` and `base` give a relative name its meaning: `prefix` is the dots
 * of a `__import__` level, and `base` is the package the dots climb from (undefined when the call
 * names none).
 */
type LoadRead =
  | {
      readonly kind: 'dynamic';
      readonly callee: string;
      readonly loadKind: LoadKind;
      readonly value: Expr;
    }
  | {
      readonly kind: 'static';
      readonly callee: string;
      readonly loadKind: LoadKind;
      readonly target: 'module' | 'path';
      readonly value: Expr;
      readonly prefix: string;
      readonly base: readonly string[] | undefined;
    };

export function createPythonLoadCollector(options: PythonLoadOptions): PythonLoadCollector {
  const facts: ModuleEdge[] = [];
  const bindings = options.bindings ?? new Map();
  return {
    observer: {
      onCall: (site: ObservedCall): void => {
        const fact = loadFactOf(site, options, bindings.get(site.info.filePath));
        if (fact !== undefined) facts.push(fact);
      },
    },
    facts: (): ModuleEdge[] => facts,
  };
}

/** The load facts grouped by file, in the form the module-load engine reads. */
export function pythonLoadFiles(facts: readonly ModuleEdge[]): FileFacts[] {
  const byFile = new Map<string, ModuleEdge[]>();
  for (const fact of facts) {
    byFile.set(fact.filePath, [...(byFile.get(fact.filePath) ?? []), fact]);
  }
  return [...byFile].map(([filePath, list]) => ({ filePath, language: 'python', facts: list }));
}

function loadFactOf(
  site: ObservedCall,
  options: PythonLoadOptions,
  bindings: ReadonlyMap<string, ModuleBinding> | undefined,
): ModuleEdge | undefined {
  const read = readLoad(site, bindings);
  if (read === undefined) return undefined;

  const file = site.info.filePath;
  const base = {
    kind: 'module-edge' as const,
    filePath: file,
    span: toSourceSpan(site.call.span, file),
    owner: site.owner,
    form: 'load' as const,
    names: [],
    typeOnly: false,
  };

  if (read.kind === 'dynamic') return dynamicFact(base, read.callee, read.loadKind, read.value);
  const name = literalName(read.value);
  if (name === undefined) return dynamicFact(base, read.callee, read.loadKind, read.value);
  const target =
    read.target === 'path'
      ? pathTargetOf(name, options.files)
      : targetOf(`${read.prefix}${name}`, read.base, options);
  return { ...base, specifier: name, loadKind: read.loadKind, target };
}

/** A load whose name is not a literal: the engine records it as an observation. */
function dynamicFact(
  base: Omit<ModuleEdge, 'specifier' | 'loadKind' | 'target'>,
  callee: string,
  loadKind: LoadKind,
  value: Expr,
): ModuleEdge {
  const text = dottedName(value) ?? '...';
  return {
    ...base,
    specifier: '',
    loadKind,
    target: {
      kind: 'unresolved',
      reason: 'dynamic-module-specifier',
      subject: `${callee}(${text})`,
    },
  };
}

/** Reads a call as a load, or undefined when the call does not load a module. */
function readLoad(
  site: ObservedCall,
  bindings: ReadonlyMap<string, ModuleBinding> | undefined,
): LoadRead | undefined {
  const func = site.call.func;
  const args = site.call.args;
  const callee = qualifiedName(func, bindings);
  const form = LOAD_FORMS.find((f) => f.callee === callee);
  if (form !== undefined) {
    const value = argumentOf(args, form.position, form.keyword);
    if (value === undefined) return undefined;
    if (form.callee === 'importlib.import_module') {
      const pkg = argumentOf(args, 1, 'package');
      if (pkg === undefined) {
        return staticRead(form, value, '', undefined, form.callee);
      }
      const packageName = literalName(pkg);
      if (packageName === undefined)
        return { kind: 'dynamic', callee: form.callee, loadKind: form.loadKind, value };
      return staticRead(form, value, '', segmentsOf(packageName), form.callee);
    }
    return staticRead(form, value, '', undefined, form.callee);
  }

  if (isDunderImport(func, site, bindings)) {
    const value = argumentOf(args, 0, 'name');
    if (value === undefined) return undefined;
    const levelArg = argumentOf(args, 4, 'level');
    if (levelArg === undefined) {
      return staticRead(
        {
          callee: DUNDER_IMPORT,
          loadKind: 'dunder-import',
          target: 'module',
          keyword: 'name',
          position: 0,
        },
        value,
        '',
        undefined,
        DUNDER_IMPORT,
      );
    }
    const level = intLiteral(levelArg);
    if (level === undefined) {
      return { kind: 'dynamic', callee: DUNDER_IMPORT, loadKind: 'dunder-import', value };
    }
    return staticRead(
      {
        callee: DUNDER_IMPORT,
        loadKind: 'dunder-import',
        target: 'module',
        keyword: 'name',
        position: 0,
      },
      value,
      '.'.repeat(level),
      packageOf(site.info.filePath),
      DUNDER_IMPORT,
    );
  }
  return undefined;
}

function staticRead(
  form: LoadForm,
  value: Expr,
  prefix: string,
  base: readonly string[] | undefined,
  callee: string,
): LoadRead {
  return {
    kind: 'static',
    callee,
    loadKind: form.loadKind,
    target: form.target,
    value,
    prefix,
    base,
  };
}

/** The builtin `__import__`: not bound by an import, and not a repository function of that name. */
function isDunderImport(
  func: Expr,
  site: ObservedCall,
  bindings: ReadonlyMap<string, ModuleBinding> | undefined,
): boolean {
  if (func.kind !== 'name' || func.id !== DUNDER_IMPORT) return false;
  if (bindings?.has(DUNDER_IMPORT)) return false;
  return resolveBase(func, site.info, site.ctx, site.declared)?.kind !== 'symbol';
}

function intLiteral(value: Expr): number | undefined {
  if (value.kind !== 'constant' || value.type !== 'number' || !/^\d+$/.test(value.raw)) {
    return undefined;
  }
  return Number(value.raw);
}

/** The package a repository file belongs to, as dotted segments. A top-level file has none. */
function packageOf(filePath: string): string[] {
  const slash = filePath.lastIndexOf('/');
  return slash < 0
    ? []
    : filePath
        .slice(0, slash)
        .split('/')
        .filter((part) => part !== '');
}

/**
 * The target of a module name. A relative name climbs from `base` one level per extra dot. A name
 * the repository does not hold, or a namespace package, has no file and is external, so the engine
 * adds nothing for it.
 */
function targetOf(
  name: string,
  base: readonly string[] | undefined,
  options: PythonLoadOptions,
): FactTarget {
  const dots = /^\.*/.exec(name)?.[0].length ?? 0;
  if (dots === 0) return lookup(segmentsOf(name), name, options);
  if (base === undefined || dots - 1 > base.length) {
    return { kind: 'unresolved', reason: 'unresolved-module-path', subject: name };
  }
  const kept = base.slice(0, base.length - (dots - 1));
  return lookup([...kept, ...segmentsOf(name.slice(dots))], name, options);
}

function lookup(segments: readonly string[], name: string, options: PythonLoadOptions): FactTarget {
  if (segments.length === 0) {
    return { kind: 'unresolved', reason: 'unresolved-module-path', subject: name };
  }
  const entry = options.index.resolve(
    segments,
    options.roots.map((root) => normalizePath(root)),
  ).entry;
  if (entry?.kind === 'module') return { kind: 'file', path: entry.file };
  if (entry?.kind === 'package') return { kind: 'file', path: entry.init };
  return { kind: 'external', name };
}

/** A literal path is a repository file when the repository holds it, and otherwise external. */
function pathTargetOf(text: string, files: ReadonlySet<string>): FactTarget {
  const repoPath = normalizePath(text);
  return files.has(repoPath) ? { kind: 'file', path: repoPath } : { kind: 'external', name: text };
}
