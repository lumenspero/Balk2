/**
 * Python callbacks (V3 Phase 12.4). Reads library calls that take a callback by keyword, such as
 * `threading.Thread(target=worker)`, and emits a call fact that the callback engine turns into
 * `passesCallback` edges, the same way it does for JS/TS.
 *
 * A library call is read only when its callee is reached through a module the file imports, such as
 * `import threading`. The callback is resolved with the call pass's own name resolution: a repository
 * function or method is a symbol, and anything else is an unresolved observation.
 *
 * Not yet read: `from threading import Thread`, a bound method such as `self.run` (unresolved for
 * now), and `executor.submit(f)`, which needs the receiver's type.
 */
import type { CallSite, FileFacts, CallbackResolution } from '../../facts/types.js';
import type { CallbackCatalogEntry } from '../../facts/callback-engine.js';
import type { Expr } from './ast.js';
import { type ObservedCall, type CallObserver } from './calls.js';
import { dottedName } from './expression-format.js';
import { resolveBase, toSourceSpan } from './inheritance.js';
import type { ModuleBinding } from './state-facts.js';

/** A library callable that takes a callback by keyword. */
interface Sink {
  readonly module: string;
  readonly attribute: string;
  readonly keyword: string;
}

const SINKS: readonly Sink[] = [{ module: 'threading', attribute: 'Thread', keyword: 'target' }];

/** The catalog the callback engine reads for the Python sinks. */
export const PYTHON_CALLBACK_CATALOG: readonly CallbackCatalogEntry[] = SINKS.map((sink) => ({
  function: sink.attribute,
  keyword: sink.keyword,
  languages: ['python'],
}));

export interface PythonCallbackOptions {
  /** Per file, the module names its imports bind, from the import resolver. */
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
  const sink = sinkOf(site.call.func, bindings);
  if (sink === undefined) return undefined;
  const arg = site.call.args.find((a) => a.kind === 'keyword' && a.name === sink.keyword);
  if (arg === undefined) return undefined;

  const file = site.info.filePath;
  return {
    kind: 'call',
    filePath: file,
    span: toSourceSpan(site.call.span, file),
    owner: site.owner,
    name: sink.attribute,
    positional: [],
    keyword: {
      [sink.keyword]: {
        kind: 'callback',
        span: toSourceSpan(arg.span, file),
        resolution: resolutionOf(arg.value, site),
      },
    },
  };
}

/** The sink a callee is, when it is `<module>.<attribute>` for a module this file imports. */
function sinkOf(
  func: Expr,
  bindings: ReadonlyMap<string, ModuleBinding> | undefined,
): Sink | undefined {
  if (func.kind !== 'attribute' || func.value.kind !== 'name') return undefined;
  const binding = bindings?.get(func.value.id);
  if (binding?.kind !== 'external') return undefined;
  return SINKS.find((s) => s.module === binding.name && s.attribute === func.attr);
}

/** What a callback argument refers to: a repository function or method, or anything unresolved. */
function resolutionOf(value: Expr, site: ObservedCall): CallbackResolution {
  if (value.kind === 'name' || value.kind === 'attribute') {
    const target = resolveBase(value, site.info, site.ctx, site.declared);
    if (target?.kind === 'symbol') {
      const kind = site.types.get(target.id);
      if (kind === 'function' || kind === 'method') return { kind: 'symbol', id: target.id };
    }
  }
  return { kind: 'unresolved', subject: dottedName(value) ?? 'callback' };
}
