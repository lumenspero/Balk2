import type { FactTarget } from '../../../facts/types.js';
import { normalizePath } from '../../../path-utils.js';
import type { Alias, Expr, Span, Stmt } from '../ast.js';
import { dirOf } from '../project/paths.js';
import { parseModuleRecovering } from '../statement-parser.js';
import { ModuleIndex, type ModuleEntry } from './module-index.js';
import { moduleNames } from './module-names.js';

/** How a statement reaches its target. `whole` is a module without a named member. */
export type ImportVia = 'whole' | 'attribute' | 'submodule' | 'star' | 'unresolved';

/** One resolved import edge from a statement. A `from` statement can yield several. */
export interface ResolvedImport {
  /** Repository-relative importing file */
  readonly filePath: string;
  /** The specifier as written: `pkg.mod`, `.util`, `..`, or `.` for `from . import x` */
  readonly specifier: string;
  readonly form: 'import' | 'from';
  readonly via: ImportVia;
  readonly target: FactTarget;
  /** Local names this edge binds */
  readonly names: readonly string[];
  /** For an `attribute` edge, the imported name behind each local name, in the same order */
  readonly imported?: readonly string[];
  readonly typeOnly: boolean;
  /** The enclosing conditions, outermost first, joined with ` > `. Never evaluated. */
  readonly condition?: string;
  readonly span: Span;
}

export interface ImportResolutionOptions {
  /** Import roots in precedence order, from Phase 4.2 */
  readonly roots: readonly string[];
  readonly readText: (path: string) => string;
}

export interface ResolveFileOptions {
  /** The directory of the file when it runs as a script. It is searched before the roots. */
  readonly scriptDir?: string;
}

export interface ImportResolver {
  resolveFile(filePath: string, source: string, options?: ResolveFileOptions): ResolvedImport[];
}

/** The state carried down into nested blocks. */
interface Scope {
  readonly typeOnly: boolean;
  readonly labels: readonly string[];
}

const ROOT_SCOPE: Scope = { typeOnly: false, labels: [] };

/**
 * Resolve the imports of Python files against a repository's module index (V3 Phase 4.3).
 *
 * Absolute imports search the script directory (when given), then the import roots. Relative
 * imports search the file's own package directory, climbed one directory per extra dot. A `from`
 * name is an attribute of the target module when the module binds it, and otherwise a submodule.
 * An internal name that matches nothing is unresolved. An external name is recorded as external.
 * `if TYPE_CHECKING:` blocks are type-only. `try` and `except` alternatives carry conditions.
 */
export function createImportResolver(
  index: ModuleIndex,
  options: ImportResolutionOptions,
): ImportResolver {
  const namesCache = new Map<string, ReturnType<typeof moduleNames>>();
  const names = (file: string): ReturnType<typeof moduleNames> => {
    const cached = namesCache.get(file);
    if (cached) return cached;
    const computed = moduleNames(options.readText(file));
    namesCache.set(file, computed);
    return computed;
  };

  return {
    resolveFile(
      filePath: string,
      source: string,
      resolveOptions: ResolveFileOptions = {},
    ): ResolvedImport[] {
      const file = normalizePath(filePath);
      const topDirs = searchPath(options.roots, resolveOptions.scriptDir);
      const out: ResolvedImport[] = [];
      const emit = (stmt: Stmt, scope: Scope): void => {
        if (stmt.kind === 'import') emitImport(file, stmt, scope, topDirs, index, out);
        else if (stmt.kind === 'importfrom') {
          emitFrom(file, stmt, scope, topDirs, index, names, out);
        }
      };
      walk(parseModuleRecovering(source).body, ROOT_SCOPE, emit);
      return out;
    },
  };
}

/** Visit every statement, descending into the blocks that can hold imports. */
function walk(
  stmts: readonly Stmt[],
  scope: Scope,
  emit: (stmt: Stmt, scope: Scope) => void,
): void {
  for (const stmt of stmts) {
    switch (stmt.kind) {
      case 'import':
      case 'importfrom':
        emit(stmt, scope);
        break;
      case 'if':
        if (isTypeChecking(stmt.test)) {
          walk(stmt.body, { typeOnly: true, labels: [...scope.labels, 'TYPE_CHECKING'] }, emit);
          walk(
            stmt.orelse,
            { typeOnly: scope.typeOnly, labels: [...scope.labels, 'not TYPE_CHECKING'] },
            emit,
          );
        } else {
          walk(stmt.body, scope, emit);
          walk(stmt.orelse, scope, emit);
        }
        break;
      case 'try':
        walk(stmt.body, labelled(scope, 'try'), emit);
        for (const handler of stmt.handlers) {
          const label = handler.type ? `except ${exceptionLabel(handler.type)}` : 'except';
          walk(handler.body, labelled(scope, label), emit);
        }
        walk(stmt.orelse, labelled(scope, 'try-else'), emit);
        walk(stmt.finalbody, scope, emit);
        break;
      case 'funcdef':
      case 'classdef':
      case 'with':
        walk(stmt.body, scope, emit);
        break;
      case 'for':
      case 'while':
        walk(stmt.body, scope, emit);
        walk(stmt.orelse, scope, emit);
        break;
      case 'match':
        for (const matchCase of stmt.cases) walk(matchCase.body, scope, emit);
        break;
      default:
        break;
    }
  }
}

function emitImport(
  file: string,
  stmt: Extract<Stmt, { kind: 'import' }>,
  scope: Scope,
  topDirs: readonly string[],
  index: ModuleIndex,
  out: ResolvedImport[],
): void {
  for (const alias of stmt.names) {
    const parts = alias.name.split('.');
    const lookup = index.resolve(parts, topDirs);
    const bound = alias.asname ?? parts[0] ?? alias.name;
    if (lookup.entry) {
      const target = fileTarget(lookup.entry);
      if (!target) continue;
      out.push(edge(file, alias.name, 'import', 'whole', target, [bound], scope, stmt.span));
    } else {
      const target = missingTarget(alias.name, parts, index, topDirs);
      out.push(edge(file, alias.name, 'import', 'unresolved', target, [bound], scope, stmt.span));
    }
  }
}

function emitFrom(
  file: string,
  stmt: Extract<Stmt, { kind: 'importfrom' }>,
  scope: Scope,
  topDirs: readonly string[],
  index: ModuleIndex,
  names: (file: string) => ReturnType<typeof moduleNames>,
  out: ResolvedImport[],
): void {
  const specifier = '.'.repeat(stmt.level) + (stmt.module ?? '');
  const parts = stmt.module ? stmt.module.split('.') : [];

  // The module the statement imports from, or the failure that stops it.
  let base: ModuleEntry | undefined;
  let failure: FactTarget | undefined;
  if (stmt.level > 0) {
    const dir = relativeBaseDir(file, stmt.level);
    if (dir === undefined) {
      failure = { kind: 'unresolved', reason: 'unresolved-module-path', subject: specifier };
    } else if (parts.length === 0) {
      base = index.packageAt(dir);
      if (!base)
        failure = { kind: 'unresolved', reason: 'unresolved-module-path', subject: specifier };
    } else {
      const lookup = index.resolve(parts, [dir]);
      base = lookup.entry;
      if (!base)
        failure = { kind: 'unresolved', reason: 'unresolved-module-path', subject: specifier };
    }
  } else {
    const lookup = index.resolve(parts, topDirs);
    base = lookup.entry;
    if (!base) {
      failure = missingTarget(specifier, parts, index, topDirs);
    }
  }

  if (!base || failure) {
    const target = failure ?? {
      kind: 'unresolved' as const,
      reason: 'unresolved-module-path' as const,
      subject: specifier,
    };
    if (stmt.names === 'star') {
      out.push(edge(file, specifier, 'from', 'unresolved', target, [], scope, stmt.span));
      return;
    }
    for (const alias of stmt.names) {
      out.push(
        edge(file, specifier, 'from', 'unresolved', target, [localName(alias)], scope, stmt.span),
      );
    }
    return;
  }

  const baseFile = fileTarget(base);
  if (stmt.names === 'star') {
    if (!baseFile) return;
    const star = starNames(baseFile.path, names);
    out.push(edge(file, specifier, 'from', 'star', baseFile, star, scope, stmt.span));
    return;
  }

  const attributes: string[] = [];
  const imported: string[] = [];
  const bound =
    baseFile && baseFile.path !== file ? new Set(names(baseFile.path).bound) : new Set<string>();
  const submodules: Array<{ alias: Alias; target: FactTarget }> = [];
  const unresolved: Array<{ alias: Alias }> = [];
  for (const alias of stmt.names) {
    if (baseFile && bound.has(alias.name)) {
      attributes.push(localName(alias));
      imported.push(alias.name);
      continue;
    }
    const child = childEntry(index, base, alias.name);
    if (child) {
      const target = fileTarget(child);
      if (target) submodules.push({ alias, target });
      continue;
    }
    unresolved.push({ alias });
  }

  if (baseFile) {
    const resolved = edge(
      file,
      specifier,
      'from',
      attributes.length > 0 ? 'attribute' : 'whole',
      baseFile,
      attributes,
      scope,
      stmt.span,
    );
    out.push(attributes.length > 0 ? { ...resolved, imported } : resolved);
  }
  for (const { alias, target } of submodules) {
    out.push(
      edge(file, specifier, 'from', 'submodule', target, [localName(alias)], scope, stmt.span),
    );
  }
  for (const { alias } of unresolved) {
    const target: FactTarget = {
      kind: 'unresolved',
      reason: 'unresolved-binding',
      subject: `${specifier}.${alias.name}`,
    };
    out.push(
      edge(file, specifier, 'from', 'unresolved', target, [localName(alias)], scope, stmt.span),
    );
  }
}

/** The submodule a `from` name refers to inside a package or namespace, if it has one. */
function childEntry(index: ModuleIndex, base: ModuleEntry, name: string): ModuleEntry | undefined {
  const dirs = index.childDirs(base);
  if (dirs.length === 0) return undefined;
  const lookup = index.resolve([name], dirs);
  return lookup.entry;
}

/** The directory a relative import starts from: the file's package, climbed `level - 1` times. */
function relativeBaseDir(file: string, level: number): string | undefined {
  const dir = dirOf(file);
  const segments = dir === '.' ? [] : dir.split('/');
  const climb = level - 1;
  if (climb > segments.length) return undefined;
  const kept = segments.slice(0, segments.length - climb);
  return kept.length > 0 ? kept.join('/') : '.';
}

/** The target for a dotted name that did not resolve: internal failures stay internal. */
export function missingTarget(
  specifier: string,
  parts: readonly string[],
  index: ModuleIndex,
  topDirs: readonly string[],
): FactTarget {
  const top = parts[0] ?? specifier;
  const internal = index.resolve([top], topDirs).entry !== undefined;
  if (internal) {
    return {
      kind: 'unresolved',
      reason: 'unresolved-module-path',
      subject: specifier,
    };
  }
  return { kind: 'external', name: top };
}

/** The file an entry's import points at. A namespace package has no file of its own. */
function fileTarget(entry: ModuleEntry): { kind: 'file'; path: string } | undefined {
  if (entry.kind === 'module') return { kind: 'file', path: entry.file };
  if (entry.kind === 'package') return { kind: 'file', path: entry.init };
  return undefined;
}

/** The names a star import binds: `__all__` when static, otherwise the public names. */
function starNames(
  file: string,
  names: (file: string) => ReturnType<typeof moduleNames>,
): string[] {
  const module = names(file);
  if (module.all !== undefined) return [...module.all];
  return module.bound.filter((name) => !name.startsWith('_'));
}

/** The roots the search goes through, with the script directory first when there is one. */
function searchPath(roots: readonly string[], scriptDir: string | undefined): string[] {
  const normalized = roots.map((root) => normalizePath(root));
  if (scriptDir === undefined) return normalized;
  const first = normalizePath(scriptDir);
  return [first, ...normalized.filter((root) => root !== first)];
}

function localName(alias: Alias): string {
  return alias.asname ?? alias.name;
}

function edge(
  filePath: string,
  specifier: string,
  form: 'import' | 'from',
  via: ImportVia,
  target: FactTarget,
  names: readonly string[],
  scope: Scope,
  span: Span,
): ResolvedImport {
  return {
    filePath,
    specifier,
    form,
    via,
    target,
    names,
    typeOnly: scope.typeOnly,
    ...(scope.labels.length > 0 ? { condition: scope.labels.join(' > ') } : {}),
    span,
  };
}

function labelled(scope: Scope, label: string): Scope {
  return { typeOnly: scope.typeOnly, labels: [...scope.labels, label] };
}

/** `TYPE_CHECKING`, bare or as `typing.TYPE_CHECKING` / `typing_extensions.TYPE_CHECKING`. */
function isTypeChecking(test: Expr): boolean {
  if (test.kind === 'name') return test.id === 'TYPE_CHECKING';
  return (
    test.kind === 'attribute' &&
    test.attr === 'TYPE_CHECKING' &&
    test.value.kind === 'name' &&
    (test.value.id === 'typing' || test.value.id === 'typing_extensions')
  );
}

/** The name of an exception expression, for a condition label. */
function exceptionLabel(expr: Expr): string {
  if (expr.kind === 'name') return expr.id;
  if (expr.kind === 'attribute') return `${exceptionLabel(expr.value)}.${expr.attr}`;
  return 'expression';
}
