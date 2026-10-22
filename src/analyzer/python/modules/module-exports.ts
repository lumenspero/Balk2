import type { FactTarget } from '../../../facts/types.js';
import type { Expr, Stmt } from '../ast.js';
import { parseModuleRecovering } from '../statement-parser.js';
import type { ImportResolver } from './import-resolution.js';
import { moduleNames } from './module-names.js';

/** One exported name, and the symbol it finally refers to (V3 Phase 4.4). */
export interface ModuleExport {
  readonly name: string;
  /** A `symbol` when the name resolves to a declaration, or the reason it does not */
  readonly origin: FactTarget;
  /** True when this module binds the name by an import rather than declaring it */
  readonly reexport: boolean;
}

export interface SymbolResolver {
  /** What a name bound at module level refers to, following re-exports and star imports */
  resolveName(file: string, name: string): FactTarget;
  /** The exports of a module, under the export rules of Phase 4.4 */
  exportsOf(file: string): ModuleExport[];
}

export interface SymbolResolverOptions {
  readonly resolver: ImportResolver;
  readonly readText: (path: string) => string;
}

interface FromBinding {
  readonly specifier: string;
  readonly original: string;
  readonly via: 'attribute' | 'submodule' | 'unresolved';
  readonly target?: FactTarget;
}

interface StarBinding {
  readonly specifier: string;
  readonly target?: FactTarget;
}

/** The top-level bindings of one module. Only top-level statements count, as in Phase 4.4. */
interface Bindings {
  readonly declared: ReadonlySet<string>;
  /** Names imported as `from x import y as y`, the redundant form that marks a re-export */
  readonly redundant: ReadonlySet<string>;
  readonly from: ReadonlyMap<string, FromBinding>;
  readonly stars: readonly StarBinding[];
}

/**
 * Resolve the names a module binds to the symbols they refer to, and compute module exports
 * (V3 Phase 4.4). A declaration is a symbol of its own file. A name imported with `from` follows
 * the import to the module that declares it, one hop at a time. Import cycles resolve as
 * unresolved rather than looping.
 *
 * Exports are `__all__` when it is static. Otherwise they are the public declared names, plus the
 * public names a package `__init__` imports, plus names imported with the redundant alias form.
 * Star imports in a package `__init__` re-export the public names of the module they come from.
 */
export function createSymbolResolver(options: SymbolResolverOptions): SymbolResolver {
  const bindingCache = new Map<string, Bindings>();
  const nameCache = new Map<string, FactTarget>();
  const exportCache = new Map<string, ModuleExport[]>();
  const nameStack = new Set<string>();
  const exportStack = new Set<string>();

  const bindings = (file: string): Bindings => {
    const cached = bindingCache.get(file);
    if (cached) return cached;
    const computed = computeBindings(file);
    bindingCache.set(file, computed);
    return computed;
  };

  const computeBindings = (file: string): Bindings => {
    const source = options.readText(file);
    const body = parseModuleRecovering(source).body;
    const results = options.resolver.resolveFile(file, source);
    const declared = new Set<string>();
    const redundant = new Set<string>();
    const from = new Map<string, FromBinding>();
    const stars: StarBinding[] = [];

    for (const stmt of body) {
      if (stmt.kind !== 'importfrom') {
        for (const name of declaredNames(stmt)) declared.add(name);
        continue;
      }
      const specifier = '.'.repeat(stmt.level) + (stmt.module ?? '');
      const edges = results.filter(
        (edge) => edge.span.line === stmt.span.line && edge.specifier === specifier,
      );
      if (stmt.names === 'star') {
        const star = edges.find((edge) => edge.via === 'star');
        stars.push({ specifier, ...(star ? { target: star.target } : {}) });
        continue;
      }
      for (const alias of stmt.names) {
        const local = alias.asname ?? alias.name;
        if (alias.asname === alias.name) redundant.add(local);
        const edge = edges.find((candidate) => candidate.names.includes(local));
        const via: FromBinding['via'] =
          edge?.via === 'submodule'
            ? 'submodule'
            : edge?.via === 'attribute'
              ? 'attribute'
              : 'unresolved';
        from.set(local, {
          specifier,
          original: alias.name,
          via,
          ...(edge ? { target: edge.target } : {}),
        });
      }
    }
    return { declared, redundant, from, stars };
  };

  const resolveName = (file: string, name: string): FactTarget => {
    const key = `${file}\u0000${name}`;
    const cached = nameCache.get(key);
    if (cached) return cached;
    if (nameStack.has(key)) return unresolvedName(file, name);
    nameStack.add(key);
    const result = computeName(file, name);
    nameStack.delete(key);
    nameCache.set(key, result);
    return result;
  };

  const computeName = (file: string, name: string): FactTarget => {
    const own = bindings(file);
    if (own.declared.has(name)) return { kind: 'symbol', id: `${file}:${name}` };

    const binding = own.from.get(name);
    if (binding) {
      if (binding.via === 'submodule' && binding.target) return binding.target;
      if (binding.via === 'attribute' && binding.target?.kind === 'file') {
        return resolveName(binding.target.path, binding.original);
      }
      return binding.target ?? unresolvedName(file, name);
    }

    for (const star of own.stars) {
      if (star.target?.kind !== 'file') continue;
      const provided = starProvides(star.target.path, name);
      if (!provided) continue;
      const origin = resolveName(star.target.path, name);
      if (origin.kind !== 'unresolved') return origin;
    }
    return unresolvedName(file, name);
  };

  /** Whether a star import from `file` brings `name` in: its `__all__` when static, else public. */
  const starProvides = (file: string, name: string): boolean => {
    const all = moduleNames(options.readText(file)).all;
    return all !== undefined ? all.includes(name) : !name.startsWith('_');
  };

  const exportsOf = (file: string): ModuleExport[] => {
    const cached = exportCache.get(file);
    if (cached) return cached;
    if (exportStack.has(file)) return [];
    exportStack.add(file);

    const own = bindings(file);
    const all = moduleNames(options.readText(file)).all;
    const isInit = /(^|\/)__init__\.pyi?$/.test(file);
    const names = new Set<string>();
    if (all !== undefined) {
      for (const name of all) names.add(name);
    } else {
      for (const name of own.declared) if (isPublic(name)) names.add(name);
      for (const local of own.from.keys()) {
        if (isPublic(local) && (isInit || own.redundant.has(local))) names.add(local);
      }
      if (isInit) {
        for (const star of own.stars) {
          if (star.target?.kind !== 'file') continue;
          for (const entry of exportsOf(star.target.path)) names.add(entry.name);
        }
      }
    }
    exportStack.delete(file);

    const result: ModuleExport[] = [...names].sort(compare).map((name) => ({
      name,
      origin: resolveName(file, name),
      reexport: !own.declared.has(name),
    }));
    exportCache.set(file, result);
    return result;
  };

  return {
    resolveName,
    exportsOf,
  };
}

/** The names a top-level statement declares. Imports are handled separately. */
function declaredNames(stmt: Stmt): string[] {
  switch (stmt.kind) {
    case 'funcdef':
    case 'classdef':
    case 'typealias':
      return [stmt.name];
    case 'assign':
      return stmt.targets.flatMap(targetNames);
    case 'annassign':
    case 'augassign':
      return targetNames(stmt.target);
    case 'for':
      return targetNames(stmt.target);
    case 'with':
      return stmt.items.flatMap((item) => (item.target ? targetNames(item.target) : []));
    default:
      return [];
  }
}

function targetNames(expr: Expr): string[] {
  if (expr.kind === 'name') return [expr.id];
  if (expr.kind === 'tuple' || expr.kind === 'list') return expr.elements.flatMap(targetNames);
  if (expr.kind === 'starred') return targetNames(expr.value);
  return [];
}

function unresolvedName(file: string, name: string): FactTarget {
  return { kind: 'unresolved', reason: 'unresolved-binding', subject: `${file}:${name}` };
}

function isPublic(name: string): boolean {
  return !name.startsWith('_');
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
