/**
 * Python dynamic module loads (Phase 12.5). `importlib.import_module(name)` is read from the call
 * observer. A literal name resolves against the repository's module index and becomes a `load`
 * module-edge fact; any other name becomes a `dynamic-module-specifier` fact. The module-load
 * engine decides what each fact adds to the graph.
 */
import type { FactTarget, FileFacts, ModuleEdge } from '../../facts/types.js';
import { normalizePath } from '../../graph.js';
import type { CallObserver, ObservedCall } from './calls.js';
import type { Expr } from './ast.js';
import type { ModuleIndex } from './modules/module-index.js';
import type { ModuleBinding } from './state-facts.js';
import { dottedName } from './expression-format.js';
import { toSourceSpan } from './inheritance.js';

export interface PythonLoadOptions {
  /** Per file, the names its imports bind, from the import resolver. */
  readonly bindings?: ReadonlyMap<string, ReadonlyMap<string, ModuleBinding>>;
  /** The repository's modules. */
  readonly index: ModuleIndex;
  /** The directories the module index is searched from. */
  readonly roots: readonly string[];
}

export interface PythonLoadCollector {
  readonly observer: CallObserver;
  facts(): ModuleEdge[];
}

const IMPORT_MODULE = 'importlib.import_module';
/** A plain or raw string literal with one quote style and no escapes. */
const LITERAL = /^[rRuU]?(['"])([^'"\\]*)\1$/;

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
  if (!isImportModule(site.call.func, bindings)) return undefined;
  const nameArg = site.call.args.find(
    (arg) => arg.kind === 'positional' || (arg.kind === 'keyword' && arg.name === 'name'),
  );
  if (nameArg === undefined) return undefined;
  const packageArg = site.call.args.find((arg) => arg.kind === 'keyword' && arg.name === 'package');

  const file = site.info.filePath;
  const base = {
    kind: 'module-edge' as const,
    filePath: file,
    span: toSourceSpan(site.call.span, file),
    owner: site.owner,
    form: 'load' as const,
    names: [],
    typeOnly: false,
    loadKind: 'import-module' as const,
  };

  const name = literalName(nameArg.value);
  const packageName = packageArg === undefined ? undefined : literalName(packageArg.value);
  if (name === undefined || (packageArg !== undefined && packageName === undefined)) {
    const argText = dottedName(nameArg.value) ?? '...';
    return {
      ...base,
      specifier: '',
      target: {
        kind: 'unresolved',
        reason: 'dynamic-module-specifier',
        subject: `${dottedName(site.call.func) ?? IMPORT_MODULE}(${argText})`,
      },
    };
  }
  return { ...base, specifier: name, target: targetOf(name, packageName, options) };
}

/** `importlib.import_module`, called as an attribute of `importlib` or by a from-imported name. */
function isImportModule(
  func: Expr,
  bindings: ReadonlyMap<string, ModuleBinding> | undefined,
): boolean {
  if (func.kind === 'name') {
    const bound = bindings?.get(func.id);
    return bound?.kind === 'member' && bound.name === IMPORT_MODULE;
  }
  if (func.kind === 'attribute' && func.attr === 'import_module' && func.value.kind === 'name') {
    const bound = bindings?.get(func.value.id);
    return bound?.kind === 'external' && bound.name === 'importlib';
  }
  return false;
}

function literalName(value: Expr): string | undefined {
  if (value.kind !== 'constant' || value.type !== 'str') return undefined;
  return LITERAL.exec(value.raw)?.[2];
}

/**
 * The target of a module name. A relative name climbs from `package` one level per extra dot. A
 * name the repository does not hold, or a namespace package, has no file and is external, so the
 * engine adds nothing for it.
 */
function targetOf(
  name: string,
  packageName: string | undefined,
  options: PythonLoadOptions,
): FactTarget {
  const dots = /^\.*/.exec(name)?.[0].length ?? 0;
  if (dots === 0) return lookup(name.split('.'), name, options);
  if (packageName === undefined) {
    return { kind: 'unresolved', reason: 'unresolved-module-path', subject: name };
  }
  const parts = packageName.split('.');
  if (dots - 1 > parts.length) {
    return { kind: 'unresolved', reason: 'unresolved-module-path', subject: name };
  }
  const kept = parts.slice(0, parts.length - (dots - 1));
  const rest = name
    .slice(dots)
    .split('.')
    .filter((part) => part !== '');
  return lookup([...kept, ...rest], name, options);
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
