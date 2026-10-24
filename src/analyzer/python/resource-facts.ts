/**
 * Python resource reads (V3 Phase 12.6). A package's data file is read in three ways. Each read that
 * names a file in the repository is a `usesResource` edge with `mechanism: 'api'`:
 *
 * - `importlib.resources.files(pkg)`, joined with `/` or `.joinpath(...)`, then read with
 *   `read_text`, `read_bytes`, `open_text`, `open_binary` or `open`;
 * - `importlib.resources.read_text(pkg, name)` and its binary and open forms;
 * - `pkgutil.get_data(pkg, name)`.
 *
 * A configured loader call (`protocols.resources`, such as `env.get_template('x.html')`) becomes a
 * call fact for the resource engine, so the loader rule and its evidence match JS/TS.
 *
 * A package or path that is not a string literal is a `dynamic-resource-specifier` observation. A
 * package that is not in the repository, or a path that names no repository file, is silent.
 */
import { detectResourceKind } from '../../data/formats.js';
import { normalizePath } from '../../graph.js';
import type { ArgValue, CallSite, FileFacts } from '../../facts/types.js';
import type { ResourceEdge } from '../../facts/resource-engine.js';
import type { ResourceProtocol } from '../resource-protocols.js';
import type { CallArg, Expr } from './ast.js';
import type { CallObserver, ObservedCall } from './calls.js';
import { argumentOf, literalName, qualifiedName, segmentsOf } from './call-names.js';
import { dottedName } from './expression-format.js';
import { toSourceSpan } from './inheritance.js';
import type { ModuleIndex } from './modules/module-index.js';
import type { ModuleBinding } from './state-facts.js';

export interface PythonResourceOptions {
  /** Per file, the names its imports bind, from the import resolver. */
  readonly bindings?: ReadonlyMap<string, ReadonlyMap<string, ModuleBinding>>;
  /** The repository's modules, for finding a package's directory. */
  readonly index: ModuleIndex;
  /** The directories the module index is searched from. */
  readonly roots: readonly string[];
  /** The repository's files, as repository-relative paths. */
  readonly files: ReadonlySet<string>;
  /** The configured loader functions, from `protocols.resources`. */
  readonly loaders: readonly ResourceProtocol[];
}

export interface PythonResourceCollector {
  readonly observer: CallObserver;
  /** The configured loader calls, as call facts for the resource engine. */
  callFacts(): CallSite[];
  /** The API reads, as resource edges and observations. */
  edges(): ResourceEdge[];
}

/** A resource: a package and the path parts under its directory. */
interface NamedResource {
  readonly pkg: string;
  readonly parts: readonly string[];
}

/** A read's resource, or `dynamic` when its package or a path part is not a string literal. */
type ResourceValue = NamedResource | 'dynamic';

const READ_METHODS: ReadonlySet<string> = new Set([
  'read_text',
  'read_bytes',
  'open_text',
  'open_binary',
  'open',
]);
const READ_FUNCTIONS: ReadonlySet<string> = new Set([
  'importlib.resources.read_text',
  'importlib.resources.read_binary',
  'importlib.resources.open_text',
  'importlib.resources.open_binary',
]);
const FILES = 'importlib.resources.files';
const GET_DATA = 'pkgutil.get_data';

export function createPythonResourceCollector(
  options: PythonResourceOptions,
): PythonResourceCollector {
  const calls: CallSite[] = [];
  const edges: ResourceEdge[] = [];
  const bindings = options.bindings ?? new Map();
  const loaders = new Map(
    options.loaders.map((protocol) => [protocol.function, protocol] as const),
  );
  return {
    observer: {
      onCall: (site: ObservedCall): void => {
        const bound = bindings.get(site.info.filePath);
        const loader = loaderCallOf(site, loaders);
        if (loader !== undefined) calls.push(loader);
        const resource = readOf(site, bound);
        if (resource === undefined) return;
        const edge = readEdge(site, resource, options);
        if (edge !== undefined) edges.push(edge);
      },
    },
    callFacts: (): CallSite[] => calls,
    edges: (): ResourceEdge[] => edges,
  };
}

/** The configured loader calls grouped by file, in the form the resource engine reads. */
export function pythonResourceFiles(calls: readonly CallSite[]): FileFacts[] {
  const byFile = new Map<string, CallSite[]>();
  for (const call of calls) {
    byFile.set(call.filePath, [...(byFile.get(call.filePath) ?? []), call]);
  }
  return [...byFile].map(([filePath, list]) => ({ filePath, language: 'python', facts: list }));
}

/** A call of a configured loader, as a call fact, when its function name is configured. */
function loaderCallOf(
  site: ObservedCall,
  loaders: ReadonlyMap<string, ResourceProtocol>,
): CallSite | undefined {
  const name = calleeName(site.call.func);
  if (name === undefined || !loaders.has(name)) return undefined;
  const file = site.info.filePath;
  const positional: ArgValue[] = site.call.args
    .filter((arg: CallArg) => arg.kind === 'positional')
    .map((arg) => argValueOf(arg.value));
  return {
    kind: 'call',
    filePath: file,
    span: toSourceSpan(site.call.span, file),
    owner: site.owner,
    name,
    text: `${dottedName(site.call.func) ?? name}(...)`,
    positional,
    keyword: {},
  };
}

/** The function a call names: a plain name, or the attribute of a method call. */
function calleeName(func: Expr): string | undefined {
  if (func.kind === 'name') return func.id;
  if (func.kind === 'attribute') return func.attr;
  return undefined;
}

function argValueOf(value: Expr): ArgValue {
  const text = literalName(value);
  return text === undefined
    ? { kind: 'dynamic', reason: 'the argument is not a string literal' }
    : { kind: 'string', value: text };
}

/** The resource a call reads, or undefined when the call reads no package resource. */
function readOf(
  site: ObservedCall,
  bound: ReadonlyMap<string, ModuleBinding> | undefined,
): ResourceValue | undefined {
  const func = site.call.func;
  if (func.kind === 'attribute' && READ_METHODS.has(func.attr)) {
    const viaMethod = resourceOf(func.value, bound);
    if (viaMethod !== undefined) return viaMethod;
  }
  const callee = qualifiedName(func, bound);
  if (callee !== undefined && (READ_FUNCTIONS.has(callee) || callee === GET_DATA)) {
    return packageArgs(site.call.args);
  }
  return undefined;
}

/** The resource a `files(...)` chain names: a package, joined with `/` or `.joinpath(...)`. */
function resourceOf(
  expr: Expr,
  bound: ReadonlyMap<string, ModuleBinding> | undefined,
): ResourceValue | undefined {
  if (expr.kind === 'binop' && expr.op === '/') {
    const left = resourceOf(expr.left, bound);
    if (left === undefined) return undefined;
    const part = literalName(expr.right);
    if (left === 'dynamic' || part === undefined) return 'dynamic';
    return { pkg: left.pkg, parts: [...left.parts, part] };
  }
  if (expr.kind !== 'call') return undefined;
  if (qualifiedName(expr.func, bound) === FILES) {
    const pkgArg = argumentOf(expr.args, 0, 'package');
    if (pkgArg === undefined) return undefined;
    const pkg = literalName(pkgArg);
    return pkg === undefined ? 'dynamic' : { pkg, parts: [] };
  }
  if (expr.func.kind === 'attribute' && expr.func.attr === 'joinpath') {
    const left = resourceOf(expr.func.value, bound);
    if (left === undefined) return undefined;
    const parts = expr.args.map((arg) =>
      arg.kind === 'positional' ? literalName(arg.value) : undefined,
    );
    if (left === 'dynamic' || parts.some((part) => part === undefined)) return 'dynamic';
    return { pkg: left.pkg, parts: [...left.parts, ...(parts as string[])] };
  }
  return undefined;
}

/** The resource named by a function's `(package, resource)` arguments. */
function packageArgs(args: readonly CallArg[]): ResourceValue | undefined {
  const pkgArg = argumentOf(args, 0, 'package');
  const nameArg = argumentOf(args, 1, 'resource');
  if (pkgArg === undefined || nameArg === undefined) return undefined;
  const pkg = literalName(pkgArg);
  const name = literalName(nameArg);
  if (pkg === undefined || name === undefined) return 'dynamic';
  return { pkg, parts: [name] };
}

/** A read as an edge to its file, an observation when it is dynamic, or nothing when it names no file. */
function readEdge(
  site: ObservedCall,
  resource: ResourceValue,
  options: PythonResourceOptions,
): ResourceEdge | undefined {
  const file = site.info.filePath;
  const from = site.owner ?? file;
  const span = toSourceSpan(site.call.span, file);
  if (resource === 'dynamic') {
    return {
      kind: 'observation',
      from,
      subject: `${dottedName(site.call.func) ?? 'read'}(...)`,
      detail: 'the package or resource is not a string literal',
      span,
    };
  }
  const dir = packageDir(resource.pkg, options);
  if (dir === undefined) return undefined;
  const repoPath = normalizePath([dir, ...resource.parts].filter((part) => part !== '').join('/'));
  if (!options.files.has(repoPath)) return undefined;
  const kind = detectResourceKind(repoPath);
  if (kind === undefined) return undefined;
  return {
    kind: 'uses',
    from,
    resourcePath: repoPath,
    resourceKind: kind,
    mechanism: 'api',
    confidence: 'high',
    evidence: 'ast',
    span,
  };
}

/** The directory of a repository package, or undefined for a module or an ambiguous namespace. */
function packageDir(pkg: string, options: PythonResourceOptions): string | undefined {
  const entry = options.index.resolve(
    segmentsOf(pkg),
    options.roots.map((root) => normalizePath(root)),
  ).entry;
  if (entry?.kind === 'package') return entry.dir;
  if (entry?.kind === 'namespace' && entry.dirs.length === 1) return entry.dirs[0];
  return undefined;
}
