/**
 * Python shared state (V3 Phase 12.3). A module global that a function writes through a `global`
 * declaration is shared state: in `def bump(): global count; count += 1`, `bump` writes and reads
 * `<file>:count`. A compound assignment both reads and writes, as it does for every state path.
 *
 * Only the function's own statements are read. A nested function or class has its own owner and
 * is reported when the call pass reaches it. Writes through `module.NAME = ...` from another module
 * are not read in this phase.
 */
import type { Expr, Span, Stmt } from './ast.js';
import { stmtBlocks } from './ast-walk.js';
import type { CallObserver, ObservedFunction } from './calls.js';
import { toSourceSpan } from './inheritance.js';
import type { StatePathFact } from '../../facts/types.js';

/** The collector: its observer feeds the call pass, and `facts()` returns the facts it read. */
export interface PythonStateCollector {
  readonly observer: CallObserver;
  facts(): StatePathFact[];
}

export function createPythonStateCollector(): PythonStateCollector {
  const facts: StatePathFact[] = [];
  return {
    observer: {
      onFunction: (site: ObservedFunction): void => {
        facts.push(...globalWritesOf(site));
      },
    },
    facts: (): StatePathFact[] => facts,
  };
}

/** One name a function's own statements assign to. */
interface Write {
  readonly name: string;
  readonly span: Span;
  readonly compound: boolean;
}

function globalWritesOf(site: ObservedFunction): StatePathFact[] {
  const globals = new Set<string>();
  const writes: Write[] = [];
  visitBlock(site.def.body, globals, writes);

  const out: StatePathFact[] = [];
  const file = site.info.filePath;
  for (const write of writes) {
    if (!globals.has(write.name)) continue;
    const span = toSourceSpan(write.span, file);
    const root = `${file}:${write.name}`;
    const base = {
      kind: 'state-path' as const,
      filePath: file,
      span,
      owner: site.id,
      rootKind: 'module' as const,
      root,
      segments: [],
      confidence: 'high' as const,
      evidence: 'ast' as const,
      subject: write.name,
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

/** Collects the `global` names and the assignments of a block, without entering nested owners. */
function visitBlock(block: readonly Stmt[], globals: Set<string>, writes: Write[]): void {
  for (const st of block) {
    if (st.kind === 'global') {
      for (const name of st.names) globals.add(name);
    } else if (st.kind === 'assign') {
      for (const target of st.targets) namesOf(target, st.span, false, writes);
    } else if (st.kind === 'augassign') {
      namesOf(st.target, st.span, true, writes);
    } else if (st.kind === 'annassign' && st.value !== null) {
      namesOf(st.target, st.span, false, writes);
    }
    for (const nested of stmtBlocks(st)) visitBlock(nested, globals, writes);
  }
}

/** The plain names an assignment target binds, including those inside a tuple or list target. */
function namesOf(target: Expr, span: Span, compound: boolean, writes: Write[]): void {
  if (target.kind === 'name') {
    writes.push({ name: target.id, span, compound });
  } else if (target.kind === 'tuple' || target.kind === 'list') {
    for (const element of target.elements) namesOf(element, span, compound, writes);
  }
}
