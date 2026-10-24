/**
 * Python shared state (V3 Phase 12.3). A module global that a function writes is shared state:
 * - through a `global` declaration: in `def bump(): global count; count += 1`, `bump` writes and
 *   reads `<file>:count`;
 * - through a module imported by name: with `import store`, `store.count = 1` writes
 *   `<store file>:count`, and `import builtins` makes `builtins.x = 1` write the global root.
 * A compound assignment both reads and writes, as it does for every state path.
 *
 * Only the statements of a function are read. A nested function or class has its own owner and
 * is reported when the call pass reaches it. Writes made by module-level code are not read yet.
 * A local name that shadows an import inside a function is not checked.
 */
import type { Expr, Span, Stmt } from './ast.js';
import { stmtBlocks } from './ast-walk.js';
import type { CallObserver, ObservedFunction } from './calls.js';
import { toSourceSpan } from './inheritance.js';
import type { StatePathFact } from '../../facts/types.js';

/** What a local name bound by an import refers to. */
export type ModuleBinding =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'external'; readonly name: string };

export interface PythonStateOptions {
  /** Per file, the module names its imports bind, from the import resolver. */
  readonly bindings?: ReadonlyMap<string, ReadonlyMap<string, ModuleBinding>>;
}

/** The collector: its observer feeds the call pass, and `facts()` returns the facts it read. */
export interface PythonStateCollector {
  readonly observer: CallObserver;
  facts(): StatePathFact[];
}

export function createPythonStateCollector(options: PythonStateOptions = {}): PythonStateCollector {
  const facts: StatePathFact[] = [];
  const bindings = options.bindings ?? new Map();
  return {
    observer: {
      onFunction: (site: ObservedFunction): void => {
        facts.push(...writesOf(site, bindings.get(site.info.filePath)));
      },
    },
    facts: (): StatePathFact[] => facts,
  };
}

/** One assignment a function's own statements make. */
type Write =
  | {
      readonly kind: 'name';
      readonly name: string;
      readonly span: Span;
      readonly compound: boolean;
    }
  | {
      readonly kind: 'attribute';
      readonly module: string;
      readonly attr: string;
      readonly span: Span;
      readonly compound: boolean;
    };

/** The state a write names: its root, its kind, and its path below the root. */
interface Target {
  readonly root: string;
  readonly rootKind: 'module' | 'global';
  readonly segments: readonly string[];
}

function writesOf(
  site: ObservedFunction,
  bindings: ReadonlyMap<string, ModuleBinding> | undefined,
): StatePathFact[] {
  const globals = new Set<string>();
  const writes: Write[] = [];
  visitBlock(site.def.body, globals, writes);

  const file = site.info.filePath;
  const out: StatePathFact[] = [];
  for (const write of writes) {
    const target = targetOf(write, globals, bindings, file);
    if (target === undefined) continue;
    const base = {
      kind: 'state-path' as const,
      filePath: file,
      span: toSourceSpan(write.span, file),
      owner: site.id,
      rootKind: target.rootKind,
      root: target.root,
      segments: [...target.segments],
      confidence: 'high' as const,
      evidence: 'ast' as const,
      subject: write.kind === 'name' ? write.name : `${write.module}.${write.attr}`,
    };
    if (write.compound) {
      out.push({ ...base, relationship: 'readsState', operation: 'compound-assign' });
    }
    out.push({
      ...base,
      relationship: 'writesState',
      operation: write.compound ? 'compound-assign' : 'assign',
    });
  }
  return out;
}

/** The state a write reaches, or undefined when it is not shared state. */
function targetOf(
  write: Write,
  globals: ReadonlySet<string>,
  bindings: ReadonlyMap<string, ModuleBinding> | undefined,
  file: string,
): Target | undefined {
  if (write.kind === 'name') {
    if (!globals.has(write.name)) return undefined;
    return { root: `${file}:${write.name}`, rootKind: 'module', segments: [] };
  }
  const binding = bindings?.get(write.module);
  if (binding === undefined) return undefined;
  if (binding.kind === 'file') {
    return { root: `${binding.path}:${write.attr}`, rootKind: 'module', segments: [] };
  }
  if (binding.name === 'builtins') {
    return { root: 'global', rootKind: 'global', segments: [write.attr] };
  }
  return undefined;
}

/** Collects the `global` names and the assignments of a block, without entering nested owners. */
function visitBlock(block: readonly Stmt[], globals: Set<string>, writes: Write[]): void {
  for (const st of block) {
    if (st.kind === 'global') {
      for (const name of st.names) globals.add(name);
    } else if (st.kind === 'assign') {
      for (const target of st.targets) collect(target, st.span, false, writes);
    } else if (st.kind === 'augassign') {
      collect(st.target, st.span, true, writes);
    } else if (st.kind === 'annassign' && st.value !== null) {
      collect(st.target, st.span, false, writes);
    }
    for (const nested of stmtBlocks(st)) visitBlock(nested, globals, writes);
  }
}

/** The names and `module.attr` targets an assignment writes, including inside a tuple or list. */
function collect(target: Expr, span: Span, compound: boolean, writes: Write[]): void {
  if (target.kind === 'name') {
    writes.push({ kind: 'name', name: target.id, span, compound });
  } else if (target.kind === 'attribute' && target.value.kind === 'name') {
    writes.push({
      kind: 'attribute',
      module: target.value.id,
      attr: target.attr,
      span,
      compound,
    });
  } else if (target.kind === 'tuple' || target.kind === 'list') {
    for (const element of target.elements) collect(element, span, compound, writes);
  }
}
