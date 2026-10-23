import { lookupDataApi } from '../../facts/data-catalog.js';
import type { DataApiMatch, DataReferenceFact } from '../../facts/types.js';
import { isDataPathLiteral } from '../../facts/path-value.js';
import type { CallArg, Expr, Stmt } from './ast.js';
import { exprChildren, stmtBlocks, stmtOwnExprs } from './ast-walk.js';
import {
  buildFileInfo,
  spanKey,
  toSourceSpan,
  type FileInfo,
  type InheritanceContext,
  type InheritanceFile,
} from './inheritance.js';

/**
 * Data lineage for Python (V3 Phase 11.2, with the constant flow of 11.5). A call whose callee
 * resolves to a catalog API gives a data-reference fact when its artifact argument is either a
 * plain string literal, or a module-level constant that holds one. The callee's dotted name is
 * resolved through the scope tracker, so a repository function called `open` or a local named
 * `pd` never matches, and `open` resolves only to the builtin.
 *
 * A constant is a module-level name with one binding in its file, a string value, and either an
 * upper-case name or a `Final` annotation. A name imported from another repository module is
 * followed to the file that declares it, and the path is placed from that file.
 */

const OPEN = 'builtins.open';
/** Modes that write: `w`, `a`, `x`, and any `+` (read and write). */
const WRITE_MODE = /[wax+]/;
/** A name the Python convention treats as a constant. */
const CONSTANT_NAME = /^[A-Z][A-Z0-9_]*$/;

/** A path value found at a call: its text, where it is written, and the file it is placed from. */
interface PathSource {
  readonly text: string;
  readonly span: Expr['span'];
  readonly declaringFile?: string;
}

/** The data-reference facts of every Python file, in source order. */
export function analyzePythonDataApis(
  sources: readonly InheritanceFile[],
  ctx: InheritanceContext,
): DataReferenceFact[] {
  const files = new Map(sources.map((file) => [file.filePath, file]));
  const infos = new Map<string, FileInfo>();
  const infoOf = (filePath: string): FileInfo | undefined => {
    const cached = infos.get(filePath);
    if (cached !== undefined) return cached;
    const file = files.get(filePath);
    if (file === undefined) return undefined;
    const info = buildFileInfo(file, ctx);
    infos.set(filePath, info);
    return info;
  };

  const facts: DataReferenceFact[] = [];
  for (const file of sources) {
    const info = infoOf(file.filePath);
    if (info === undefined) continue;
    walkBody(
      info.body,
      (call, scope) => facts.push(...factsOfCall(call, info, infoOf, scope)),
      info.body,
    );
  }
  return facts;
}

/** Visits every call with the body of its enclosing function, or the module body at top level. */
function walkBody(
  body: readonly Stmt[],
  visit: (call: Expr, scope: readonly Stmt[]) => void,
  scope: readonly Stmt[],
): void {
  for (const st of body) {
    for (const e of stmtOwnExprs(st)) walkExpr(e, (call) => visit(call, scope));
    if (st.kind === 'funcdef') {
      walkBody(st.body, visit, st.body);
      continue;
    }
    if (st.kind === 'classdef') walkBody(st.body, visit, scope);
    for (const block of stmtBlocks(st)) walkBody(block, visit, scope);
  }
}

function walkExpr(e: Expr, visit: (call: Expr) => void): void {
  if (e.kind === 'call') visit(e);
  for (const child of exprChildren(e)) walkExpr(child, visit);
}

/** The names a binding target introduces: a name, or the names inside a tuple, list or star. */
function boundNames(target: Expr): string[] {
  if (target.kind === 'name') return [target.id];
  if (target.kind === 'starred') return boundNames(target.value);
  if (target.kind === 'tuple' || target.kind === 'list') {
    return exprChildren(target).flatMap(boundNames);
  }
  return [];
}

/** How a name is bound within one body: how many times, and the value of a sole plain binding. */
interface Binding {
  readonly count: number;
  readonly value?: Expr;
}

const bindingCache = new WeakMap<readonly Stmt[], Map<string, Binding>>();

/**
 * The bindings of a name in one scope, not counting nested functions and classes. A name bound
 * once by `name = value` gives that value, which a method call's receiver is typed from (Phase 11.6).
 */
function bindingsOf(name: string, body: readonly Stmt[]): Binding {
  let byName = bindingCache.get(body);
  if (byName === undefined) {
    byName = new Map();
    bindingCache.set(body, byName);
  }
  const cached = byName.get(name);
  if (cached !== undefined) return cached;

  let count = 0;
  let value: Expr | undefined;
  const bind = (target: Expr, plain: Expr | undefined): void => {
    if (!boundNames(target).includes(name)) return;
    count++;
    value = plain;
  };
  const visit = (stmts: readonly Stmt[]): void => {
    for (const st of stmts) {
      if (st.kind === 'assign') {
        for (const target of st.targets)
          bind(target, st.targets.length === 1 ? st.value : undefined);
      } else if (st.kind === 'annassign') {
        bind(st.target, st.value ?? undefined);
      } else if (st.kind === 'for') {
        bind(st.target, undefined);
      } else if (st.kind === 'with') {
        for (const item of st.items) if (item.target) bind(item.target, undefined);
      } else if (st.kind === 'funcdef' || st.kind === 'classdef') {
        if (st.name === name) {
          count++;
          value = undefined;
        }
      } else if (st.kind === 'import') {
        // `import os.path` binds `os`; `import x as y` binds `y` (Phase 11.6).
        for (const alias of st.names) {
          const bound = alias.asname ?? alias.name.split('.')[0];
          if (bound === name) {
            count++;
            value = undefined;
          }
        }
      } else if (st.kind === 'importfrom') {
        if (st.names === 'star') {
          // A star import may bind any name, so the name is not typed in this scope.
          count++;
          value = undefined;
        } else {
          for (const alias of st.names) {
            if ((alias.asname ?? alias.name) === name) {
              count++;
              value = undefined;
            }
          }
        }
      }
      for (const block of stmtBlocks(st)) visit(block);
    }
  };
  visit(body);

  const result: Binding = { count, value: count === 1 ? value : undefined };
  byName.set(name, result);
  return result;
}

/**
 * The call that made a method call's receiver: the receiver itself when it is a call, or the call
 * a name is bound to once in its scope, falling back to the module for a name the function does not
 * bind. Undefined for any other receiver.
 */
function receiverCall(
  receiver: Expr,
  scope: readonly Stmt[],
  moduleBody: readonly Stmt[],
): Expr | undefined {
  if (receiver.kind === 'call') return receiver;
  if (receiver.kind !== 'name') return undefined;
  let found = bindingsOf(receiver.id, scope);
  if (found.count === 0 && scope !== moduleBody) found = bindingsOf(receiver.id, moduleBody);
  return found.value?.kind === 'call' ? found.value : undefined;
}

/**
 * The dotted API name an expression names, such as `pandas.read_csv` for `pd.read_csv` after
 * `import pandas as pd`, or `builtins.open` for the builtin `open`. Undefined when the name is a
 * local, a repository symbol, or anything the scope tracker cannot resolve.
 */
export function qualifiedName(e: Expr, info: FileInfo): string | undefined {
  if (e.kind === 'name') {
    const resolution = info.uses.get(spanKey(e.span))?.resolution;
    if (resolution?.kind === 'builtin') return `builtins.${e.id}`;
    if (resolution?.kind !== 'scope' || resolution.scopeKind !== 'module') return undefined;
    const imported = info.imported.get(e.id);
    if (imported === undefined || imported.module === '' || imported.module.startsWith('.')) {
      return undefined;
    }
    return imported.name === null ? imported.module : `${imported.module}.${imported.name}`;
  }
  if (e.kind === 'attribute') {
    const base = qualifiedName(e.value, info);
    return base === undefined ? undefined : `${base}.${e.attr}`;
  }
  return undefined;
}

/** The positional arguments of a call, in order. */
function positionals(args: readonly CallArg[]): Expr[] {
  return args.filter((arg) => arg.kind === 'positional').map((arg) => arg.value);
}

/** The text of a plain, unescaped string literal, or undefined for anything else. */
function stringValue(e: Expr | undefined): { text: string; span: Expr['span'] } | undefined {
  if (e === undefined || e.kind !== 'constant' || e.type !== 'str') return undefined;
  const match = /^(['"])([^'"\\]*)\1$/.exec(e.raw);
  return match?.[2] === undefined ? undefined : { text: match[2], span: e.span };
}

/** The mode of an `open` call: its second positional argument or its `mode=` keyword. */
function openMode(args: readonly CallArg[]): string | undefined {
  const modeArg = positionals(args)[1] ?? args.find((arg) => arg.name === 'mode')?.value;
  return stringValue(modeArg)?.text;
}

/** The mode of a `Path.open` call: its first positional argument or its `mode=` keyword. */
function pathOpenMode(args: readonly CallArg[]): string | undefined {
  const modeArg = positionals(args)[0] ?? args.find((arg) => arg.name === 'mode')?.value;
  return stringValue(modeArg)?.text;
}

/**
 * The facts of a method call whose receiver is a `pathlib.Path` or a DataFrame read by pandas
 * (Phase 11.6). Undefined when the receiver's type is not known, so the call takes the usual path.
 */
function methodFacts(
  call: Expr & { readonly kind: 'call' },
  func: Expr & { readonly kind: 'attribute' },
  info: FileInfo,
  infoOf: (filePath: string) => FileInfo | undefined,
  scope: readonly Stmt[],
): DataReferenceFact[] | undefined {
  const producer = receiverCall(func.value, scope, info.body);
  if (producer === undefined || producer.kind !== 'call') return undefined;
  const type = qualifiedName(producer.func, info);
  if (type === undefined) return undefined;
  const method = func.attr;

  if (type === 'pathlib.Path') {
    const source = pathSourceOf(positionals(producer.args)[0], info, infoOf, scope);
    if (method === 'open') {
      const mode = pathOpenMode(call.args);
      const direction = mode !== undefined && WRITE_MODE.test(mode) ? 'generates' : 'consumes';
      const match: DataApiMatch = { module: 'pathlib.Path', name: 'open', direction };
      return factAt(info, source, match, 'pathlib.Path.open');
    }
    const entry = lookupDataApi('python', 'pathlib.Path', method, -1);
    if (entry === undefined) return [];
    const match: DataApiMatch = {
      module: entry.module,
      name: entry.name,
      direction: entry.direction,
    };
    return factAt(info, source, match, `pathlib.Path.${method}`);
  }

  const frame = frameTypeOf(type);
  if (frame !== undefined) {
    const found: DataReferenceFact[] = [];
    positionals(call.args).forEach((value, index) => {
      const entry = lookupDataApi('python', frame, method, index);
      if (entry === undefined) return;
      const match: DataApiMatch = {
        module: entry.module,
        name: entry.name,
        direction: entry.direction,
      };
      found.push(
        ...factAt(info, pathSourceOf(value, info, infoOf, scope), match, `${frame}.${method}`),
      );
    });
    return found;
  }
  return undefined;
}

/**
 * The frame type a pandas or Polars reader returns (Phase 11.6): `read_*` gives a DataFrame, and
 * `scan_*` a LazyFrame. Undefined for any other call.
 */
function frameTypeOf(type: string): string | undefined {
  const dot = type.lastIndexOf('.');
  const module = type.slice(0, dot);
  const reader = type.slice(dot + 1);
  if (module !== 'pandas' && module !== 'polars') return undefined;
  if (lookupDataApi('python', module, reader, 0) === undefined) return undefined;
  return reader.startsWith('scan_') ? `${module}.LazyFrame` : `${module}.DataFrame`;
}

/** True for `Final`, `typing.Final`, and `Final[...]` annotations. */
function isFinal(annotation: Expr): boolean {
  if (annotation.kind === 'subscript') return isFinal(annotation.value);
  if (annotation.kind === 'name') return annotation.id === 'Final';
  return annotation.kind === 'attribute' && annotation.attr === 'Final';
}

/**
 * The string a module-level constant holds, when the module binds the name exactly once and that
 * binding is a string literal under the constant rules. Undefined for anything else.
 */
function moduleConstant(info: FileInfo, name: string): string | undefined {
  if (info.imported.has(name)) return undefined;
  let bindings = 0;
  let value: string | undefined;
  for (const st of info.body) {
    if (st.kind === 'assign') {
      for (const target of st.targets) {
        if (target.kind !== 'name' || target.id !== name) continue;
        bindings++;
        const literal = stringValue(st.value);
        value = CONSTANT_NAME.test(name) ? literal?.text : undefined;
      }
    } else if (st.kind === 'annassign' && st.target.kind === 'name' && st.target.id === name) {
      bindings++;
      const literal = st.value === null ? undefined : stringValue(st.value);
      value = literal !== undefined && isFinal(st.annotation) ? literal.text : undefined;
    } else if ((st.kind === 'funcdef' || st.kind === 'classdef') && st.name === name) {
      bindings++;
    }
  }
  return bindings === 1 ? value : undefined;
}

/**
 * The path a bare name holds, when it names a module-level constant here or one imported from a
 * repository module (Phase 11.5).
 */
function flowedConstant(
  name: Expr & { readonly kind: 'name' },
  info: FileInfo,
  infoOf: (filePath: string) => FileInfo | undefined,
): { text: string; declaringFile: string } | undefined {
  const resolution = info.uses.get(spanKey(name.span))?.resolution;
  if (resolution?.kind !== 'scope' || resolution.scopeKind !== 'module') return undefined;

  const imported = info.imported.get(name.id);
  if (imported === undefined) {
    const text = moduleConstant(info, name.id);
    return text === undefined ? undefined : { text, declaringFile: info.filePath };
  }
  if (imported.name === null) return undefined;

  const link = info.resolvedImports.find(
    (r) => r.target.kind === 'file' && r.names.includes(name.id),
  );
  if (link === undefined || link.target.kind !== 'file') return undefined;
  const declaring = infoOf(link.target.path);
  const text = declaring === undefined ? undefined : moduleConstant(declaring, imported.name);
  return text === undefined ? undefined : { text, declaringFile: link.target.path };
}

/**
 * The path an argument holds: a string literal, a name bound once to a string literal in the
 * function it is used in, or a module-level constant (Phase 11.5). A name bound in the function
 * more than once holds no single path, and does not fall through to a module constant of the same
 * name.
 */
function pathSourceOf(
  value: Expr | undefined,
  info: FileInfo,
  infoOf: (filePath: string) => FileInfo | undefined,
  scope: readonly Stmt[],
): PathSource | undefined {
  if (value === undefined) return undefined;
  const literal = stringValue(value);
  if (literal !== undefined) return literal;
  if (value.kind !== 'name') return undefined;
  if (scope !== info.body) {
    const local = bindingsOf(value.id, scope);
    if (local.count > 0) {
      const text = local.count === 1 ? stringValue(local.value) : undefined;
      return text === undefined
        ? undefined
        : { text: text.text, span: value.span, declaringFile: info.filePath };
    }
  }
  const flow = flowedConstant(value, info, infoOf);
  return flow === undefined
    ? undefined
    : { text: flow.text, span: value.span, declaringFile: flow.declaringFile };
}

function factsOfCall(
  call: Expr,
  info: FileInfo,
  infoOf: (filePath: string) => FileInfo | undefined,
  scope: readonly Stmt[],
): DataReferenceFact[] {
  if (call.kind !== 'call') return [];
  if (call.func.kind === 'attribute') {
    const typed = methodFacts(call, call.func, info, infoOf, scope);
    if (typed !== undefined) return typed;
  }
  const api = qualifiedName(call.func, info);
  if (api === undefined) return [];

  const dot = api.lastIndexOf('.');
  if (dot < 0) return [];
  const module = api.slice(0, dot);
  const name = api.slice(dot + 1);

  // `open` is a read unless its mode writes. Its path is always the first argument.
  if (api === OPEN) {
    const mode = openMode(call.args);
    const direction = mode !== undefined && WRITE_MODE.test(mode) ? 'generates' : 'consumes';
    const match: DataApiMatch = { module: 'builtins', name, direction };
    return factAt(info, pathSourceOf(positionals(call.args)[0], info, infoOf, scope), match, api);
  }

  const found: DataReferenceFact[] = [];
  positionals(call.args).forEach((value, index) => {
    const entry = lookupDataApi('python', module, name, index);
    if (entry === undefined) return;
    const match: DataApiMatch = {
      module: entry.module,
      name: entry.name,
      direction: entry.direction,
    };
    found.push(
      ...factAt(info, pathSourceOf(value, info, infoOf, scope), match, `${module}.${name}`),
    );
  });
  return found;
}

/** A fact for a path source, when its text names a data file. */
function factAt(
  info: FileInfo,
  source: PathSource | undefined,
  api: DataApiMatch,
  context: string,
): DataReferenceFact[] {
  if (source === undefined || !isDataPathLiteral(source.text)) return [];
  return [
    {
      kind: 'data-reference',
      filePath: info.filePath,
      span: toSourceSpan(source.span, info.filePath),
      path: source.text,
      context,
      api,
      ...(source.declaringFile === undefined || source.declaringFile === info.filePath
        ? {}
        : { pathFilePath: source.declaringFile }),
    },
  ];
}
