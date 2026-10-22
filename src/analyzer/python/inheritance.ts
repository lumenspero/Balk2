/**
 * Python inheritance (V3 Phase 5.3).
 *
 * For every class in the repository this resolves its base expressions, computes its method
 * resolution order over repository classes with C3 linearization, and marks classes that are
 * abstract. It also reads `SomeABC.register(Cls)` calls as implementations.
 *
 * Base resolution uses the same bindings as the rest of the front end:
 * - A name bound at module level resolves through `SymbolResolver.resolveName`, which follows
 *   imports and re-exports.
 * - A name bound in a class body names the nested class (`Outer.Inner`).
 * - `module.Name` resolves when `module` is a repository module bound by an `import`.
 * - `Outer.Inner` resolves to the nested class when `Outer` is a repository class.
 * - A name bound by a star import is `ambiguous-star-import`. A name nothing binds is undefined.
 *
 * Abstract markers are the imported names `typing.Protocol`, `abc.ABC` and `abc.ABCMeta`, read
 * from the module's own import statements, and `metaclass=ABCMeta`. A class is abstract when it
 * has a marker, or any repository base is abstract.
 *
 * Limitations: a class nested in a function is not resolved by name, because its owner id has no
 * function qualifier and its scope label has one. Star-imported base names are not guessed.
 */
import { ownerIdOf, type OwnerScope } from '../../facts/owner-rule.js';
import type { FactTarget } from '../../facts/types.js';
import type { SourceSpan } from '../../types.js';
import type { Expr, Span, Stmt } from './ast.js';
import { formatExpr } from './expression-format.js';
import type { ImportResolver, ResolvedImport } from './modules/import-resolution.js';
import type { SymbolResolver } from './modules/module-exports.js';
import { analyzeScopes, type NameUse, type ScopeAnalysis } from './scopes.js';
import { parseModuleRecovering } from './statement-parser.js';
import { analyzePythonSymbols, type PythonSymbolAnalysis } from './symbols.js';

const ABSTRACT_MARKERS: ReadonlySet<string> = new Set([
  'typing.Protocol',
  'abc.ABC',
  'abc.ABCMeta',
]);

export interface InheritanceFile {
  readonly filePath: string;
  readonly source: string;
}

export interface InheritanceContext {
  readonly symbols: SymbolResolver;
  readonly imports: ImportResolver;
}

/** One base expression of a class. `target` is undefined when nothing binds the name. */
export interface BaseRef {
  readonly text: string;
  readonly span: SourceSpan;
  readonly target: FactTarget | undefined;
}

export interface ClassInheritance {
  /** The class's symbol id. A conditionally defined class has one entry per definition. */
  readonly id: string;
  readonly filePath: string;
  readonly span: SourceSpan;
  readonly bases: readonly BaseRef[];
  /** C3 linearization over repository classes, starting with the class. Null when inconsistent. */
  readonly mro: readonly string[] | null;
  readonly abstract: boolean;
}

/** `classId` implements `abcId`, from `abcId.register(classId)`. */
export interface ImplementsRelation {
  readonly classId: string;
  readonly abcId: string;
  readonly filePath: string;
  readonly span: SourceSpan;
}

export interface InheritanceProblem {
  readonly filePath: string;
  readonly span: SourceSpan;
  readonly message: string;
}

export interface InheritanceAnalysis {
  readonly classes: readonly ClassInheritance[];
  readonly implementations: readonly ImplementsRelation[];
  readonly problems: readonly InheritanceProblem[];
}

interface ImportedName {
  /** The module as written, or its first component for `import a.b` */
  readonly module: string;
  /** The imported name, or null for a module import */
  readonly name: string | null;
}

interface Located {
  readonly st: Stmt;
  readonly chain: readonly OwnerScope[];
}

interface FileInfo {
  readonly filePath: string;
  readonly declarations: PythonSymbolAnalysis['declarations'];
  readonly scopes: ScopeAnalysis;
  readonly uses: ReadonlyMap<string, NameUse>;
  readonly imported: ReadonlyMap<string, ImportedName>;
  readonly resolvedImports: readonly ResolvedImport[];
  readonly located: readonly Located[];
}

interface ClassRecord {
  readonly id: string;
  readonly filePath: string;
  readonly span: SourceSpan;
  readonly bases: readonly BaseRef[];
  readonly directAbstract: boolean;
}

function toSourceSpan(span: Span, filePath: string): SourceSpan {
  return {
    filePath,
    startLine: span.line,
    startColumn: span.column,
    endLine: span.endLine,
    endColumn: span.endColumn,
  };
}

function spanKey(span: Span): string {
  return `${span.line}:${span.column}`;
}

function topLevel(dotted: string): string {
  const dot = dotted.indexOf('.');
  return dot < 0 ? dotted : dotted.slice(0, dot);
}

/** Every statement in a file, with the scopes that enclose it, outermost first. */
function locate(stmts: readonly Stmt[], chain: readonly OwnerScope[], out: Located[]): void {
  for (const st of stmts) {
    out.push({ st, chain });
    switch (st.kind) {
      case 'funcdef': {
        const inClass = chain[chain.length - 1]?.kind === 'class';
        locate(st.body, [...chain, { kind: inClass ? 'method' : 'function', name: st.name }], out);
        break;
      }
      case 'classdef':
        locate(st.body, [...chain, { kind: 'class', name: st.name }], out);
        break;
      case 'if':
      case 'while':
      case 'for':
        locate(st.body, chain, out);
        locate(st.orelse, chain, out);
        break;
      case 'with':
        locate(st.body, chain, out);
        break;
      case 'try':
        locate(st.body, chain, out);
        for (const h of st.handlers) locate(h.body, chain, out);
        locate(st.orelse, chain, out);
        locate(st.finalbody, chain, out);
        break;
      case 'match':
        for (const c of st.cases) locate(c.body, chain, out);
        break;
      default:
        break;
    }
  }
}

function importsOf(located: readonly Located[]): Map<string, ImportedName> {
  const out = new Map<string, ImportedName>();
  for (const { st } of located) {
    if (st.kind === 'import') {
      for (const alias of st.names) {
        if (alias.asname !== null) out.set(alias.asname, { module: alias.name, name: null });
        else out.set(topLevel(alias.name), { module: topLevel(alias.name), name: null });
      }
    } else if (st.kind === 'importfrom' && st.names !== 'star') {
      for (const alias of st.names) {
        out.set(alias.asname ?? alias.name, { module: st.module ?? '', name: alias.name });
      }
    }
  }
  return out;
}

function buildFileInfo(file: InheritanceFile, ctx: InheritanceContext): FileInfo {
  const { body } = parseModuleRecovering(file.source);
  const scopes = analyzeScopes(body);
  const uses = new Map<string, NameUse>();
  for (const use of scopes.uses) uses.set(spanKey(use.span), use);
  const located: Located[] = [];
  locate(body, [], located);
  return {
    filePath: file.filePath,
    declarations: analyzePythonSymbols(file.source, file.filePath).declarations,
    scopes,
    uses,
    imported: importsOf(located),
    resolvedImports: ctx.imports.resolveFile(file.filePath, file.source),
    located,
  };
}

/** The abstract marker an expression names through an import, such as `typing.Protocol`. */
function markerOf(e: Expr, info: FileInfo): string | undefined {
  if (e.kind === 'name') {
    const imp = info.imported.get(e.id);
    return imp !== undefined && imp.name !== null ? `${imp.module}.${imp.name}` : undefined;
  }
  if (e.kind === 'attribute' && e.value.kind === 'name') {
    const imp = info.imported.get(e.value.id);
    return imp !== undefined && imp.name === null ? `${imp.module}.${e.attr}` : undefined;
  }
  return undefined;
}

/** The repository file a module-level name refers to, when it is a module and not a member. */
function moduleFileOf(info: FileInfo, name: string): string | undefined {
  const found = info.resolvedImports.find(
    (r) => r.names.includes(name) && (r.via === 'whole' || r.via === 'submodule'),
  );
  return found !== undefined && found.target.kind === 'file' ? found.target.path : undefined;
}

function resolveBase(
  e: Expr,
  info: FileInfo,
  ctx: InheritanceContext,
  declared: ReadonlySet<string>,
): FactTarget | undefined {
  switch (e.kind) {
    case 'name': {
      const resolution = info.uses.get(spanKey(e.span))?.resolution;
      if (resolution === undefined) return undefined;
      switch (resolution.kind) {
        case 'scope': {
          if (resolution.scopeKind === 'module')
            return ctx.symbols.resolveName(info.filePath, e.id);
          if (resolution.scopeKind === 'class') {
            const label = info.scopes.scopes.find((s) => s.id === resolution.scope)?.label;
            if (label === undefined) return undefined;
            const id = `${info.filePath}:${label}.${e.id}`;
            return declared.has(id) ? { kind: 'symbol', id } : undefined;
          }
          return undefined;
        }
        case 'builtin':
          return { kind: 'external', name: 'builtins' };
        case 'implicit':
          return undefined;
        case 'unresolved':
          return resolution.reason === 'star-import'
            ? { kind: 'unresolved', reason: 'ambiguous-star-import', subject: e.id }
            : undefined;
      }
      return undefined;
    }
    case 'attribute': {
      if (e.value.kind === 'name') {
        const module = moduleFileOf(info, e.value.id);
        if (module !== undefined) return ctx.symbols.resolveName(module, e.attr);
        const imp = info.imported.get(e.value.id);
        if (imp !== undefined && imp.name === null) {
          return { kind: 'external', name: topLevel(imp.module) };
        }
      }
      const base = resolveBase(e.value, info, ctx, declared);
      if (base?.kind === 'symbol') {
        const id = `${base.id}.${e.attr}`;
        return declared.has(id) ? { kind: 'symbol', id } : undefined;
      }
      return base?.kind === 'external' ? base : undefined;
    }
    default:
      return undefined;
  }
}

/** The C3 merge step. Returns null when the sequences have no consistent order. */
function merge(sequences: readonly (readonly string[])[]): string[] | null {
  const work = sequences.map((s) => [...s]);
  const out: string[] = [];
  for (;;) {
    const remaining = work.filter((s) => s.length > 0);
    if (remaining.length === 0) return out;
    let chosen: string | undefined;
    for (const seq of remaining) {
      const head = seq[0];
      if (head !== undefined && remaining.every((other) => !other.slice(1).includes(head))) {
        chosen = head;
        break;
      }
    }
    if (chosen === undefined) return null;
    out.push(chosen);
    for (const seq of work) if (seq[0] === chosen) seq.shift();
  }
}

/**
 * Analyzes the inheritance of every class in a set of Python files. The files are analyzed
 * together, because C3 linearization needs the bases of classes in other files. Never throws on
 * malformed input.
 */
export function analyzeInheritance(
  files: readonly InheritanceFile[],
  ctx: InheritanceContext,
): InheritanceAnalysis {
  const infos = files.map((f) => buildFileInfo(f, ctx));
  const declared = new Set<string>();
  const classIds = new Set<string>();
  for (const info of infos) {
    for (const d of info.declarations) {
      declared.add(d.id);
      if (d.symbolType === 'class') classIds.add(d.id);
    }
  }

  const records: ClassRecord[] = [];
  for (const info of infos) {
    for (const { st, chain } of info.located) {
      if (st.kind !== 'classdef') continue;
      const id = ownerIdOf(info.filePath, [...chain, { kind: 'class', name: st.name }]);
      const bases: BaseRef[] = [];
      let directAbstract = false;
      for (const arg of st.bases) {
        if (arg.kind === 'positional') {
          bases.push({
            text: formatExpr(arg.value),
            span: toSourceSpan(arg.value.span, info.filePath),
            target: resolveBase(arg.value, info, ctx, declared),
          });
          if (ABSTRACT_MARKERS.has(markerOf(arg.value, info) ?? '')) directAbstract = true;
        } else if (arg.kind === 'keyword' && arg.name === 'metaclass') {
          if (markerOf(arg.value, info) === 'abc.ABCMeta') directAbstract = true;
        }
      }
      records.push({
        id,
        filePath: info.filePath,
        span: toSourceSpan(st.span, info.filePath),
        bases,
        directAbstract,
      });
    }
  }

  // Repository bases per class id. Conditional twins contribute the union of their bases.
  const basesOf = new Map<string, string[]>();
  const directAbstract = new Map<string, boolean>();
  const classSpan = new Map<string, SourceSpan>();
  for (const r of records) {
    if (!classSpan.has(r.id)) classSpan.set(r.id, r.span);
    directAbstract.set(r.id, (directAbstract.get(r.id) ?? false) || r.directAbstract);
    const list = basesOf.get(r.id) ?? [];
    for (const b of r.bases) {
      if (b.target?.kind === 'symbol' && classIds.has(b.target.id) && !list.includes(b.target.id)) {
        list.push(b.target.id);
      }
    }
    basesOf.set(r.id, list);
  }

  const problems: InheritanceProblem[] = [];
  const mroMemo = new Map<string, string[] | null>();
  const mroStack = new Set<string>();
  const mroOf = (id: string): string[] | null => {
    const known = mroMemo.get(id);
    if (known !== undefined) return known;
    const span = classSpan.get(id);
    if (mroStack.has(id)) {
      if (span !== undefined) {
        problems.push({ filePath: span.filePath, span, message: `inheritance cycle at ${id}` });
      }
      return null;
    }
    mroStack.add(id);
    const bases = basesOf.get(id) ?? [];
    const sequences: string[][] = [];
    let ok = true;
    for (const base of bases) {
      const m = mroOf(base);
      if (m === null) ok = false;
      else sequences.push(m);
    }
    let result: string[] | null = null;
    if (ok) {
      const merged = merge([...sequences, [...bases]]);
      if (merged === null) {
        if (span !== undefined) {
          problems.push({
            filePath: span.filePath,
            span,
            message: `no consistent method resolution order for ${id}`,
          });
        }
      } else {
        result = [id, ...merged];
      }
    }
    mroStack.delete(id);
    mroMemo.set(id, result);
    return result;
  };

  const abstractMemo = new Map<string, boolean>();
  const abstractStack = new Set<string>();
  const abstractOf = (id: string): boolean => {
    const known = abstractMemo.get(id);
    if (known !== undefined) return known;
    if (abstractStack.has(id)) return false;
    abstractStack.add(id);
    const result =
      (directAbstract.get(id) ?? false) || (basesOf.get(id) ?? []).some((b) => abstractOf(b));
    abstractStack.delete(id);
    abstractMemo.set(id, result);
    return result;
  };

  const classes: ClassInheritance[] = records.map((r) => ({
    id: r.id,
    filePath: r.filePath,
    span: r.span,
    bases: r.bases,
    mro: mroOf(r.id),
    abstract: abstractOf(r.id),
  }));

  const implementations: ImplementsRelation[] = [];
  for (const info of infos) {
    for (const { st } of info.located) {
      if (st.kind !== 'expr' || st.value.kind !== 'call') continue;
      const call = st.value;
      const func = call.func;
      if (func.kind !== 'attribute' || func.attr !== 'register' || call.args.length !== 1) continue;
      const arg = call.args[0];
      if (arg === undefined || arg.kind !== 'positional') continue;
      const abc = resolveBase(func.value, info, ctx, declared);
      const cls = resolveBase(arg.value, info, ctx, declared);
      if (
        abc?.kind === 'symbol' &&
        classIds.has(abc.id) &&
        cls?.kind === 'symbol' &&
        classIds.has(cls.id)
      ) {
        implementations.push({
          classId: cls.id,
          abcId: abc.id,
          filePath: info.filePath,
          span: toSourceSpan(st.span, info.filePath),
        });
      }
    }
  }

  return { classes, implementations, problems };
}
