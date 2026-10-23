import { describe, expect, it } from 'vitest';
import { bindImports } from './imports.js';
import { buildCrateIndex, type RustCrateIndex } from './module-index.js';
import { bindTypeRelations, type TypeRelations } from './type-relations.js';

const ENV = { externs: new Set(['serde']), repoCrates: new Map() };

function relationsOf(files: Record<string, string>): TypeRelations {
  const crate: RustCrateIndex = buildCrateIndex({
    root: 'src/lib.rs',
    files: new Set(Object.keys(files)),
    readText: (file) => files[file] ?? '',
    edition: '2021',
  });
  bindImports(crate, ENV);
  return bindTypeRelations(crate, ENV);
}

function edgesOf(relations: TypeRelations): [string, string, string][] {
  return relations.edges.map((edge) => [edge.kind, edge.from, edge.to]);
}

describe('bindTypeRelations: implements', () => {
  it('gives implements from the type to the trait', () => {
    const relations = relationsOf({
      'src/lib.rs': 'pub struct User; pub trait Render {} impl Render for User {}',
    });
    expect(edgesOf(relations)).toEqual([['implements', 'src/lib.rs:User', 'src/lib.rs:Render']]);
    expect(relations.unresolved).toEqual([]);
  });

  it('attaches an impl in another file to the struct it names', () => {
    const relations = relationsOf({
      'src/lib.rs': 'pub mod models; pub mod render;',
      'src/models.rs': 'pub struct User;',
      'src/render.rs': 'pub trait Render {} use crate::models::User; impl Render for User {}',
    });
    expect(relations.edges).toEqual([
      expect.objectContaining({
        kind: 'implements',
        from: 'src/models.rs:User',
        to: 'src/render.rs:Render',
        file: 'src/render.rs',
      }),
    ]);
  });

  it('handles an impl and a trait in an inline module', () => {
    const relations = relationsOf({
      'src/lib.rs': 'mod shapes { pub trait Area {} pub struct Sq; impl Area for Sq {} }',
    });
    expect(edgesOf(relations)).toEqual([
      ['implements', 'src/lib.rs:shapes::Sq', 'src/lib.rs:shapes::Area'],
    ]);
  });

  it('gives nothing for an inherent impl', () => {
    expect(relationsOf({ 'src/lib.rs': 'struct A; impl A { fn f(&self) {} }' }).edges).toEqual([]);
  });

  it('gives nothing for a blanket impl over a type parameter', () => {
    expect(
      relationsOf({ 'src/lib.rs': 'pub trait Render {} impl<T> Render for T {}' }).edges,
    ).toEqual([]);
  });

  it('gives nothing for a trait from outside the repository', () => {
    const relations = relationsOf({
      'src/lib.rs': 'use std::fmt::Display; struct User; impl Display for User {}',
    });
    expect(relations.edges).toEqual([]);
    expect(relations.unresolved).toEqual([]);
  });

  it('reports a trait path that names a missing module as unresolved', () => {
    const relations = relationsOf({
      'src/lib.rs': 'struct User; impl crate::missing::Render for User {}',
    });
    expect(relations.edges).toEqual([]);
    expect(relations.unresolved).toEqual([
      expect.objectContaining({
        kind: 'implements',
        reason: 'unresolved-module-path',
        subject: 'crate::missing::Render',
      }),
    ]);
  });
});

describe('bindTypeRelations: extends', () => {
  it('gives extends from a trait to each supertrait in the repository', () => {
    const relations = relationsOf({
      'src/lib.rs': 'pub trait Base {} pub trait Child: Base + Send {}',
    });
    expect(edgesOf(relations)).toEqual([['extends', 'src/lib.rs:Child', 'src/lib.rs:Base']]);
  });

  it('reads generic supertraits without splitting inside their arguments', () => {
    const relations = relationsOf({
      'src/lib.rs': 'pub trait Source<T> {} pub trait Sink {} pub trait Pipe: Source<u8> + Sink {}',
    });
    expect(edgesOf(relations)).toEqual([
      ['extends', 'src/lib.rs:Pipe', 'src/lib.rs:Source'],
      ['extends', 'src/lib.rs:Pipe', 'src/lib.rs:Sink'],
    ]);
  });
});
