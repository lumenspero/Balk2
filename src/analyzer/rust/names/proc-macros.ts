/**
 * Proc macros (V3 Phase 10.3).
 *
 * An internal proc-macro crate defines macros as functions. A `#[proc_macro_derive(Name)]`
 * function provides `#[derive(Name)]`, and a `#[proc_macro_attribute]` function provides
 * `#[name]`. A function-like `#[proc_macro]` is a target only, with no edge in this phase.
 *
 * A derive or attribute on an item in a crate that depends directly on the proc-macro crate
 * links the item to the function that provides it, as `references` with `mechanism` set to
 * `derive` or `attribute`. A name provided by two proc-macro dependencies links to neither.
 */
import type { Attribute, Span } from '../items.js';
import type { RustCrateIndex } from './module-index.js';

export type ProcMacroKind = 'derive' | 'attribute';

/** A crate of the repository, with its package id and whether it is a proc-macro crate. */
export interface ProcMacroCrate {
  /** The crate's target id, as the dependency edges name it. */
  readonly id: string;
  readonly index: RustCrateIndex;
  readonly procMacro: boolean;
}

/** A dependency of one crate target on another, as the package model reports it. */
export interface ProcMacroDependency {
  readonly from: string;
  readonly to: string;
}

export interface ProcMacroEdge {
  /** The item that carries the derive or attribute. */
  readonly from: string;
  /** The function that provides the macro. */
  readonly to: string;
  /** The file of the item. */
  readonly file: string;
  readonly span: Span;
  readonly mechanism: ProcMacroKind;
}

interface ProcMacroDef {
  readonly kind: ProcMacroKind;
  readonly name: string;
  readonly id: string;
  readonly crateId: string;
}

/** Links each derive and attribute in the repository to the proc macro that provides it. */
export function bindProcMacros(
  crates: readonly ProcMacroCrate[],
  dependencies: readonly ProcMacroDependency[],
): ProcMacroEdge[] {
  const defs: ProcMacroDef[] = [];
  for (const crate of crates) {
    if (!crate.procMacro) continue;
    for (const fn of crate.index.functions) {
      if (fn.container !== null) continue;
      for (const attr of fn.item.attrs) {
        if (attr.path === 'proc_macro_derive') {
          const name = firstArgument(attr);
          if (name !== undefined) defs.push({ kind: 'derive', name, id: fn.id, crateId: crate.id });
        } else if (attr.path === 'proc_macro_attribute') {
          defs.push({ kind: 'attribute', name: fn.item.name, id: fn.id, crateId: crate.id });
        }
      }
    }
  }
  if (defs.length === 0) return [];

  const edges: ProcMacroEdge[] = [];
  for (const crate of crates) {
    const providers = defs.filter(
      (def) =>
        def.crateId !== crate.id &&
        dependencies.some((d) => d.from === crate.id && d.to === def.crateId),
    );
    if (providers.length === 0) continue;

    for (const decl of crate.index.decls) {
      const item = decl.item;
      for (const attr of item.attrs) {
        if (attr.path === 'derive') {
          if (item.kind !== 'struct' && item.kind !== 'union' && item.kind !== 'enum') continue;
          for (const name of deriveNames(attr)) {
            const target = uniqueProvider(providers, 'derive', name);
            if (target !== undefined) {
              edges.push({
                from: decl.id,
                to: target,
                file: decl.owner.file,
                span: attr.span,
                mechanism: 'derive',
              });
            }
          }
        } else {
          const target = uniqueProvider(providers, 'attribute', lastSegment(attr.path));
          if (target !== undefined) {
            edges.push({
              from: decl.id,
              to: target,
              file: decl.owner.file,
              span: attr.span,
              mechanism: 'attribute',
            });
          }
        }
      }
    }

    for (const fn of crate.index.functions) {
      if (fn.container !== null) continue;
      for (const attr of fn.item.attrs) {
        if (attr.path === 'derive') continue;
        const target = uniqueProvider(providers, 'attribute', lastSegment(attr.path));
        if (target !== undefined) {
          edges.push({
            from: fn.id,
            to: target,
            file: fn.owner.file,
            span: attr.span,
            mechanism: 'attribute',
          });
        }
      }
    }
  }
  return edges;
}

/** The provider of a derive or attribute name, when exactly one dependency provides it. */
function uniqueProvider(
  providers: readonly ProcMacroDef[],
  kind: ProcMacroKind,
  name: string,
): string | undefined {
  const ids = new Set(
    providers.filter((def) => def.kind === kind && def.name === name).map((def) => def.id),
  );
  return ids.size === 1 ? [...ids][0] : undefined;
}

/** The raw argument text of an attribute, without its outer parentheses, split at top-level commas. */
export function argumentParts(attr: Attribute): string[] {
  let text = attr.raw.trim();
  if (text.startsWith('(')) text = text.slice(1);
  if (text.endsWith(')')) text = text.slice(0, -1);
  return text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** The first argument of `proc_macro_derive(Name, attributes(...))`, which is the derive's name. */
function firstArgument(attr: Attribute): string | undefined {
  const [first] = argumentParts(attr);
  return first === undefined ? undefined : lastSegment(first);
}

/** The derive names in `#[derive(A, path::B)]`, each reduced to its last segment. */
function deriveNames(attr: Attribute): string[] {
  return argumentParts(attr)
    .map(lastSegment)
    .filter((name) => name.length > 0);
}

/** The last `::` segment of a path, with spaces removed (`web :: route` becomes `route`). */
function lastSegment(path: string): string {
  const parts = path.split('::').map((part) => part.replace(/\s+/g, ''));
  return parts[parts.length - 1] ?? '';
}
