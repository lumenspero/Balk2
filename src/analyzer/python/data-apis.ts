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
    walkBody(info.body, (call) => facts.push(...factsOfCall(call, info, infoOf)));
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

/** The path an argument holds: a string literal, or a module-level constant. */
function pathSourceOf(
  value: Expr | undefined,
  info: FileInfo,
  infoOf: (filePath: string) => FileInfo | undefined,
): PathSource | undefined {
  if (value === undefined) return undefined;
  const literal = stringValue(value);
  if (literal !== undefined) return literal;
  if (value.kind !== 'name') return undefined;
  const flow = flowedConstant(value, info, infoOf);
  return flow === undefined
    ? undefined
    : { text: flow.text, span: value.span, declaringFile: flow.declaringFile };
}

function factsOfCall(
  call: Expr,
  info: FileInfo,
  infoOf: (filePath: string) => FileInfo | undefined,
): DataReferenceFact[] {
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
    const match: DataApiMatch = { module: 'builtins', name, direction };
    return factAt(info, pathSourceOf(positionals(call.args)[0], info, infoOf), match, api);
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
    found.push(...factAt(info, pathSourceOf(value, info, infoOf), match, `${module}.${name}`));
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
