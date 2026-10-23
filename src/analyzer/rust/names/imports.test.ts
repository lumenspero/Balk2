import { describe, expect, it } from 'vitest';
import { bindImports, type ImportResult } from './imports.js';
import { buildCrateIndex, type RustCrateIndex, type RustModuleNode } from './module-index.js';
import { resolveName, type RustNameEnvironment, type Resolution } from './resolve.js';

function crateOf(
  files: Record<string, string>,
  root = 'src/lib.rs',
  edition = '2021',
): RustCrateIndex {
  return buildCrateIndex({
    root,
    files: new Set(Object.keys(files)),
    readText: (file) => files[file] ?? '',
    edition,
  });
}

function bind(crate: RustCrateIndex, env: RustNameEnvironment = NO_ENV): ImportResult {
  return bindImports(crate, env);
}

function child(node: RustModuleNode, name: string): RustModuleNode {
  const found = node.children.get(name);
  if (found === undefined) throw new Error(`no module ${name}`);
  return found;
}

function resolve(
  crate: RustCrateIndex,
  text: string,
  ns: 'type' | 'value' = 'type',
  from: RustModuleNode = crate.root,
  env: RustNameEnvironment = NO_ENV,
): Resolution {
  return resolveName({ global: false, segments: text.split('::') }, ns, from, crate, env);
}

const NO_ENV: RustNameEnvironment = { externs: new Set(['serde']), repoCrates: new Map() };

describe('bindImports: named imports', () => {
  it('binds a use to its item and emits an imports edge to the item file', () => {
    const crate = crateOf({
      'src/lib.rs': 'pub mod models; use crate::models::User; use models::Config as C;',
      'src/models.rs': 'pub struct User; pub struct Config;',
    });
    const result = bind(crate);
    expect(result.edges.map((edge) => [edge.file, edge.target, edge.glob])).toEqual([
      ['src/lib.rs', 'src/models.rs', false],
      ['src/lib.rs', 'src/models.rs', false],
    ]);
    expect(result.unresolved).toEqual([]);
    expect(resolve(crate, 'User')).toEqual({ kind: 'symbol', id: 'src/models.rs:User' });
    expect(resolve(crate, 'C')).toEqual({ kind: 'symbol', id: 'src/models.rs:Config' });
  });

  it('binds a group with self and a rename', () => {
    const crate = crateOf({
      'src/lib.rs':
        'mod util { pub fn helper() {} pub struct Inner; } use util::{self as u, Inner};',
    });
    bind(crate);
    const found = resolve(crate, 'u');
    expect(found).toMatchObject({ kind: 'module', node: { path: 'util' } });
    expect(resolve(crate, 'Inner')).toEqual({ kind: 'symbol', id: 'src/lib.rs:util::Inner' });
  });

  it('binds nothing for as _, but still emits its edge', () => {
    const crate = crateOf({
      'src/lib.rs': 'mod a; use a::Thing as _;',
      'src/a.rs': 'pub trait Thing {}',
    });
    const result = bind(crate);
    expect(result.edges.map((edge) => edge.target)).toEqual(['src/a.rs']);
    expect(result.unresolved).toEqual([]);
  });

  it('lets an item of the same name take precedence over a use', () => {
    const crate = crateOf({
      'src/lib.rs': 'mod a; use a::Item; pub struct Item;',
      'src/a.rs': 'pub struct Item;',
    });
    bind(crate);
    expect(resolve(crate, 'Item')).toEqual({ kind: 'symbol', id: 'src/lib.rs:Item' });
  });

  it('resolves a use that names something another use brings in', () => {
    const crate = crateOf({
      'src/lib.rs': 'mod a; use crate::b::Item; mod b; ',
      'src/a.rs': 'pub struct Item;',
      'src/b.rs': 'pub use crate::a::Item;',
    });
    expect(bind(crate).unresolved).toEqual([]);
    expect(resolve(crate, 'Item')).toEqual({ kind: 'symbol', id: 'src/a.rs:Item' });
  });
});

describe('bindImports: globs', () => {
  it('brings in the public names of a glob source', () => {
    const crate = crateOf({
      'src/lib.rs': 'mod a; use a::*;',
      'src/a.rs': 'pub struct Item; fn hidden() {}',
    });
    const result = bind(crate);
    expect(result.edges).toEqual([
      { file: 'src/lib.rs', target: 'src/a.rs', span: expect.anything(), glob: true },
    ]);
    expect(resolve(crate, 'Item')).toEqual({ kind: 'symbol', id: 'src/a.rs:Item' });
    expect(resolve(crate, 'hidden', 'value')).toEqual({ kind: 'not-found' });
  });

  it('does not bring in a private child module through a glob from outside its parent', () => {
    const crate = crateOf({
      'src/lib.rs': 'mod a; use a::*;',
      'src/a.rs': 'mod inner;',
      'src/a/inner.rs': 'pub struct Item;',
    });
    bind(crate);
    expect(resolve(crate, 'inner')).toEqual({ kind: 'not-found' });
  });

  it('brings in a pub(crate) child module through a glob from another module', () => {
    const crate = crateOf({
      'src/lib.rs': 'mod a; use a::*;',
      'src/a.rs': 'pub(crate) mod inner;',
      'src/a/inner.rs': 'pub struct Item;',
    });
    bind(crate);
    expect(resolve(crate, 'inner')).toMatchObject({ kind: 'module' });
  });

  it('gives an explicit use precedence over a glob', () => {
    const crate = crateOf({
      'src/lib.rs': 'mod a; mod b; use a::*; use b::Item;',
      'src/a.rs': 'pub struct Item;',
      'src/b.rs': 'pub struct Item;',
    });
    bind(crate);
    expect(resolve(crate, 'Item')).toEqual({ kind: 'symbol', id: 'src/b.rs:Item' });
  });

  it('reports two globs that supply different targets for one name as ambiguous', () => {
    const crate = crateOf({
      'src/lib.rs': 'mod a; mod b; use a::*; use b::*;',
      'src/a.rs': 'pub struct Item;',
      'src/b.rs': 'pub struct Item;',
    });
    bind(crate);
    expect(resolve(crate, 'Item')).toMatchObject({
      kind: 'unresolved',
      reason: 'ambiguous-star-import',
    });
  });

  it('lets a child module see its parent through super::*, including private items', () => {
    const crate = crateOf({
      'src/lib.rs': '#[cfg(test)] mod tests { use super::*; fn check() {} } fn helper() {}',
    });
    bind(crate);
    const tests = child(crate.root, 'tests');
    expect(resolve(crate, 'helper', 'value', tests)).toEqual({
      kind: 'symbol',
      id: 'src/lib.rs:helper',
    });
  });
});

describe('bindImports: unresolved and external', () => {
  it('reports a use of a missing path as unresolved', () => {
    const crate = crateOf({ 'src/lib.rs': 'use crate::nope::X;' });
    expect(bind(crate).unresolved).toEqual([
      expect.objectContaining({
        subject: 'crate::nope::X',
        reason: 'unresolved-module-path',
      }),
    ]);
  });

  it('treats a use of an extern crate as external: no edge, nothing unresolved', () => {
    const crate = crateOf({ 'src/lib.rs': 'use serde::Serialize;' });
    const result = bind(crate);
    expect(result.edges).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(resolve(crate, 'Serialize')).toEqual({ kind: 'extern', crate: 'serde' });
  });

  it('resolves a use from the crate root in edition 2015', () => {
    const crate = crateOf(
      {
        'src/lib.rs': 'pub mod models; mod util { use models::User; }',
        'src/models.rs': 'pub struct User;',
      },
      'src/lib.rs',
      '2015',
    );
    expect(bind(crate).unresolved).toEqual([]);
    const util = child(crate.root, 'util');
    expect(resolve(crate, 'User', 'type', util)).toEqual({
      kind: 'symbol',
      id: 'src/models.rs:User',
    });
  });

  it('resolves a use of another repository crate and emits an edge to its file', () => {
    const ingest = crateOf(
      { 'crates/ingest/src/lib.rs': 'pub fn build() {}' },
      'crates/ingest/src/lib.rs',
    );
    const crate = crateOf({ 'src/lib.rs': 'use ingest::build;' });
    const env: RustNameEnvironment = {
      externs: new Set(),
      repoCrates: new Map([['ingest', ingest]]),
    };
    const result = bind(crate, env);
    expect(result.edges.map((edge) => edge.target)).toEqual(['crates/ingest/src/lib.rs']);
    expect(resolve(crate, 'build', 'value', crate.root, env)).toEqual({
      kind: 'symbol',
      id: 'crates/ingest/src/lib.rs:build',
    });
  });
});
