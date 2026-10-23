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
 * Data lineage for Python (V3 Phase 11.2). A call whose callee resolves to a catalog API, with a
 * string literal in the artifact's argument position, gives a data-reference fact. The callee's
 * dotted name is resolved through the scope tracker, so a repository function called `open` or a
 * local named `pd` never matches, and `open` resolves only to the builtin.
 */

const OPEN = 'builtins.open';
/** Modes that write: `w`, `a`, `x`, and any `+` (read and write). */
const WRITE_MODE = /[wax+]/;

/** The data-reference facts of every Python file, in source order. */
export function analyzePythonDataApis(
  sources: readonly InheritanceFile[],
  ctx: InheritanceContext,
): DataReferenceFact[] {
  const facts: DataReferenceFact[] = [];
  for (const file of sources) {
    const info = buildFileInfo(file, ctx);
    walkBody(info.body, (call) => facts.push(...factsOfCall(call, info)));
  }
  return facts;
}

function walkBody(body: readonly Stmt[], visit: (call: Expr) => void): void {
  for (const st of body) {
    for (const e of stmtOwnExprs(st)) walkExpr(e, visit);
    for (const block of stmtBlocks(st)) walkBody(block, visit);
  }
}

function walkExpr(e: Expr, visit: (call: Expr) => void): void {
  if (e.kind === 'call') visit(e);
  for (const child of exprChildren(e)) walkExpr(child, visit);
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

function factsOfCall(call: Expr, info: FileInfo): DataReferenceFact[] {
  if (call.kind !== 'call') return [];
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
    return factAt(
      call,
      info,
      positionals(call.args)[0],
      { module: 'builtins', name, direction },
      api,
    );
  }

  const found: DataReferenceFact[] = [];
  positionals(call.args).forEach((value, index) => {
    const entry = lookupDataApi('python', module, name, index);
    if (entry === undefined) return;
    const api: DataApiMatch = {
      module: entry.module,
      name: entry.name,
      direction: entry.direction,
    };
    found.push(...factAt(call, info, value, api, api.module + '.' + api.name));
  });
  return found;
}

/** A fact for a plain string literal at `value`, when it names a data file. */
function factAt(
  _call: Expr,
  info: FileInfo,
  value: Expr | undefined,
  api: DataApiMatch,
  context: string,
): DataReferenceFact[] {
  const literal = stringValue(value);
  if (literal === undefined || !isDataPathLiteral(literal.text)) return [];
  return [
    {
      kind: 'data-reference',
      filePath: info.filePath,
      span: toSourceSpan(literal.span, info.filePath),
      path: literal.text,
      context,
      api,
    },
  ];
}
