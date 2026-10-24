/**
 * Python callbacks (V3 Phase 12.4). Reads library and builtin calls that take a callback, such as
 * `threading.Thread(target=worker)`, `atexit.register(cleanup)`, `sorted(items, key=by_name)` and
 * `map(double, xs)`. Each one becomes a call fact, which the callback engine turns into
 * `passesCallback` edges, the same way it does for JS/TS.
 *
 * A library callee is read only when its module is imported (`import threading`) or its member is
 * imported by name (`from threading import Thread`). A builtin is read by its bare name, only when
 * the file does not bind that name by an import and no repository function of that name is
 * declared. The callback is resolved with the call pass's own name resolution: a repository
 * function or method is a symbol, and anything else is an unresolved observation.
 *
 * `signal.SIG_DFL` and `signal.SIG_IGN` are constants, not handlers, so they give no edge.
 *
 * Not yet read: a bound method such as `self.run` (unresolved for now), `executor.submit(f)` and
 * `executor.map(f, xs)`, which need the receiver's type, and `loop.call_soon(f)`.
 */
import type { ArgValue, CallSite, CallbackResolution, FileFacts } from '../../facts/types.js';
import type { CallbackCatalogEntry } from '../../facts/callback-engine.js';
import type { CallArg, Expr } from './ast.js';
import type { CallObserver, ObservedCall } from './calls.js';
import { dottedName } from './expression-format.js';
import { resolveBase, toSourceSpan } from './inheritance.js';
import type { ModuleBinding } from './state-facts.js';

/** Where a sink takes its callback: a positional index, or a keyword argument. */
type CallbackPlace = { readonly position: number } | { readonly keyword: string };

/** A callable that takes a callback. A builtin is called by its bare name. */
interface Sink {
  /** The module the callable is in, or `builtins` */
  readonly module: string;
  readonly attribute: string;
  readonly place: CallbackPlace;
  readonly builtin?: boolean;
}

const SINKS: readonly Sink[] = [
  { module: 'threading', attribute: 'Thread', place: { keyword: 'target' } },
  { module: 'atexit', attribute: 'register', place: { position: 0 } },
  { module: 'signal', attribute: 'signal', place: { position: 1 } },
  { module: 'functools', attribute: 'partial', place: { position: 0 } },
  { module: 'builtins', attribute: 'sorted', place: { keyword: 'key' }, builtin: true },
  { module: 'builtins', attribute: 'min', place: { keyword: 'key' }, builtin: true },
  { module: 'builtins', attribute: 'max', place: { keyword: 'key' }, builtin: true },
  { module: 'builtins', attribute: 'map', place: { position: 0 }, builtin: true },
  { module: 'builtins', attribute: 'filter', place: { position: 0 }, builtin: true },
];

/** The `signal` module's handler constants, which are not functions. */
const SIGNAL_CONSTANTS: ReadonlySet<string> = new Set(['SIG_DFL', 'SIG_IGN']);

/** The catalog the callback engine reads for the Python sinks. */
export const PYTHON_CALLBACK_CATALOG: readonly CallbackCatalogEntry[] = SINKS.map((sink) => ({
  function: sink.attribute,
  ...('keyword' in sink.place
    ? { keyword: sink.place.keyword }
    : { callbackArg: sink.place.position }),
  languages: ['python'],
}));

export interface PythonCallbackOptions {
  /** Per file, the names its imports bind, from the import resolver. */
  readonly bindings?: ReadonlyMap<string, ReadonlyMap<string, ModuleBinding>>;
}

export interface PythonCallbackCollector {
  readonly observer: CallObserver;
  facts(): CallSite[];
}

export function createPythonCallbackCollector(
  options: PythonCallbackOptions = {},
): PythonCallbackCollector {
  const facts: CallSite[] = [];
  const bindings = options.bindings ?? new Map();
  return {
    observer: {
      onCall: (site: ObservedCall): void => {
        const fact = callbackFactOf(site, bindings.get(site.info.filePath));
        if (fact !== undefined) facts.push(fact);
      },
    },
    facts: (): CallSite[] => facts,
  };
}

/** The callback facts grouped by file, in the form the callback engine reads. */
export function pythonCallbackFiles(facts: readonly CallSite[]): FileFacts[] {
  const byFile = new Map<string, CallSite[]>();
  for (const fact of facts) {
    byFile.set(fact.filePath, [...(byFile.get(fact.filePath) ?? []), fact]);
  }
  return [...byFile].map(([filePath, list]) => ({ filePath, language: 'python', facts: list }));
}

function callbackFactOf(
  site: ObservedCall,
  bindings: ReadonlyMap<string, ModuleBinding> | undefined,
): CallSite | undefined {
  const sink = sinkOf(site, bindings);
  if (sink === undefined) return undefined;
  const place = sink.place;
  const arg = argumentAt(site.call.args, place);
  if (arg === undefined) return undefined;
  const resolution = resolutionOf(arg.value, site);
  if (resolution === undefined) return undefined;

  const file = site.info.filePath;
  const callback: ArgValue = {
    kind: 'callback',
    span: toSourceSpan(arg.span, file),
    resolution,
  };
  const keyword = 'keyword' in place;
  return {
    kind: 'call',
    filePath: file,
    span: toSourceSpan(site.call.span, file),
    owner: site.owner,
    name: sink.attribute,
    positional: keyword ? [] : positionalWith(place.position, callback),
    keyword: keyword ? { [place.keyword]: callback } : {},
  };
}

/** The argument that holds the callback, by keyword or by position among the positional arguments. */
function argumentAt(args: readonly CallArg[], place: CallbackPlace): CallArg | undefined {
  if ('keyword' in place) return args.find((a) => a.kind === 'keyword' && a.name === place.keyword);
  return args.filter((a) => a.kind === 'positional')[place.position];
}

/** A positional argument list with the callback at `position` and nothing known elsewhere. */
function positionalWith(position: number, callback: ArgValue): ArgValue[] {
  return Array.from({ length: position + 1 }, (_, index): ArgValue =>
    index === position ? callback : { kind: 'unknown' },
  );
}

/** The sink a call is, when its callee is a library callable this file imports, or a builtin. */
function sinkOf(
  site: ObservedCall,
  bindings: ReadonlyMap<string, ModuleBinding> | undefined,
): Sink | undefined {
  const func = site.call.func;
  if (func.kind === 'name') {
    const bound = bindings?.get(func.id);
    if (bound?.kind === 'member') {
      return SINKS.find((s) => `${s.module}.${s.attribute}` === bound.name);
    }
    if (bound !== undefined) return undefined;
    // Not bound by an import: a builtin, unless a repository function of that name is declared.
    if (resolveBase(func, site.info, site.ctx, site.declared)?.kind === 'symbol') return undefined;
    return SINKS.find((s) => s.builtin === true && s.attribute === func.id);
  }
  if (func.kind !== 'attribute' || func.value.kind !== 'name') return undefined;
  const binding = bindings?.get(func.value.id);
  if (binding?.kind !== 'external') return undefined;
  return SINKS.find(
    (s) => s.builtin !== true && s.module === binding.name && s.attribute === func.attr,
  );
}

/**
 * What a callback argument refers to: a repository function or method, or anything else as an
 * unresolved observation. Undefined for a `signal` constant, which is not a callback at all.
 */
function resolutionOf(value: Expr, site: ObservedCall): CallbackResolution | undefined {
  if (value.kind === 'attribute' && SIGNAL_CONSTANTS.has(value.attr)) return undefined;
  if (value.kind === 'name' && SIGNAL_CONSTANTS.has(value.id)) return undefined;
  if (value.kind === 'name' || value.kind === 'attribute') {
    const target = resolveBase(value, site.info, site.ctx, site.declared);
    if (target?.kind === 'symbol') {
      const kind = site.types.get(target.id);
      if (kind === 'function' || kind === 'method') return { kind: 'symbol', id: target.id };
    }
  }
  return { kind: 'unresolved', subject: dottedName(value) ?? 'callback' };
}
