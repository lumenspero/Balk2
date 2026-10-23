/**
 * `implements` and `extends` between the types and traits of one Rust crate (V3 Phase 9.5).
 *
 * - `impl Trait for Type` gives `implements` from the type's symbol to the trait's symbol. Both
 *   are resolved through their paths in the module the `impl` is written in, so an impl in another
 *   file attaches to the struct it names. An inherent impl gives nothing: its methods belong to
 *   the type already.
 * - `trait A: B + C` gives `extends` from A to each supertrait that resolves in the repository.
 *
 * A type or trait that resolves outside the repository (a standard or extern crate, such as
 * `Display` after `use std::fmt::Display`) gives no edge and no observation. A blanket impl, whose
 * self type is one of its own type parameters, names no type and gives nothing.
 * A path that looks internal and does not resolve is reported as unresolved.
 */
import type { Span } from '../items.js';
import type { RustCrateIndex, RustModuleNode } from './module-index.js';
import {
  resolveName,
  type RustNameEnvironment,
  type RustPath,
  type UnresolvedReason,
} from './resolve.js';
import { pathOfTokens, splitBounds } from './type-paths.js';

export interface TypeRelationEdge {
  readonly kind: 'implements' | 'extends';
  /** The type that implements, or the trait that extends. */
  readonly from: string;
  /** The trait implemented, or the supertrait. */
  readonly to: string;
  readonly file: string;
  readonly span: Span;
}

export interface TypeRelationUnresolved {
  readonly kind: 'implements' | 'extends';
  readonly file: string;
  readonly span: Span;
  readonly subject: string;
  readonly reason: UnresolvedReason;
  readonly detail: string;
}

export interface TypeRelations {
  readonly edges: readonly TypeRelationEdge[];
  readonly unresolved: readonly TypeRelationUnresolved[];
}

type TypeLookup =
  | { readonly kind: 'found'; readonly id: string }
  | { readonly kind: 'unresolved'; readonly reason: UnresolvedReason; readonly detail: string }
  | { readonly kind: 'none' };

/** Binds the `impl` and `trait` declarations of a crate to edges. */
export function bindTypeRelations(crate: RustCrateIndex, env: RustNameEnvironment): TypeRelations {
  const edges: TypeRelationEdge[] = [];
  const unresolved: TypeRelationUnresolved[] = [];
  const report = (
    kind: 'implements' | 'extends',
    owner: RustModuleNode,
    span: Span,
    subject: string,
    lookup: { readonly reason: UnresolvedReason; readonly detail: string },
  ): void => {
    unresolved.push({
      kind,
      file: owner.file,
      span,
      subject,
      reason: lookup.reason,
      detail: lookup.detail,
    });
  };

  for (const impl of crate.impls) {
    if (impl.trait === null) continue;
    const selfPath = pathOfTokens(impl.selfTy.tokens);
    const traitPath = pathOfTokens(impl.trait.tokens);
    if (selfPath === null || traitPath === null) continue;
    if (selfPath.segments.length === 1 && impl.generics.includes(selfPath.segments[0] ?? ''))
      continue;

    const type = lookupType(selfPath, impl.owner, crate, env);
    const trait = lookupType(traitPath, impl.owner, crate, env);
    for (const lookup of [type, trait]) {
      if (lookup.kind === 'unresolved') {
        report(
          'implements',
          impl.owner,
          impl.span,
          (lookup === type ? selfPath : traitPath).segments.join('::'),
          lookup,
        );
      }
    }
    if (type.kind === 'found' && trait.kind === 'found') {
      edges.push({
        kind: 'implements',
        from: type.id,
        to: trait.id,
        file: impl.owner.file,
        span: impl.span,
      });
    }
  }

  for (const trait of crate.traits) {
    if (trait.supertraits === null) continue;
    const id = trait.owner.tables.get(trait.owner.scope)?.type.get(trait.name);
    if (id === undefined) continue;
    for (const bound of splitBounds(trait.supertraits.tokens)) {
      const path = pathOfTokens(bound);
      if (path === null) continue;
      const lookup = lookupType(path, trait.owner, crate, env);
      if (lookup.kind === 'found') {
        edges.push({
          kind: 'extends',
          from: id,
          to: lookup.id,
          file: trait.owner.file,
          span: trait.span,
        });
      } else if (lookup.kind === 'unresolved') {
        report('extends', trait.owner, trait.span, path.segments.join('::'), lookup);
      }
    }
  }

  return { edges, unresolved };
}

/** The symbol a type or trait path names, looked up in the type namespace. */
function lookupType(
  path: RustPath,
  owner: RustModuleNode,
  crate: RustCrateIndex,
  env: RustNameEnvironment,
): TypeLookup {
  const resolution = resolveName(path, 'type', owner, crate, env);
  if (resolution.kind === 'symbol') return { kind: 'found', id: resolution.id };
  if (resolution.kind === 'unresolved') {
    return { kind: 'unresolved', reason: resolution.reason, detail: resolution.detail };
  }
  return { kind: 'none' };
}
