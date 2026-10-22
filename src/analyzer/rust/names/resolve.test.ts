import { describe, expect, it } from 'vitest';
import { buildCrateIndex, type RustCrateIndex, type RustModuleNode } from './module-index.js';
import { resolvePath, type RustNameEnvironment, type RustPath } from './resolve.js';

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

function child(node: RustModuleNode, name: string): RustModuleNode {
  const found = node.children.get(name);
  if (found === undefined) throw new Error(`no module ${name}`);
  return found;
}

function path(text: string): RustPath {
  return { global: text.startsWith('::'), segments: text.replace(/^::/, '').split('::') };
}

const NO_EXTERNS: RustNameEnvironment = { externs: new Set(), repoCrates: new Map() };

const FILES: Record<string, string> = {
  'src/lib.rs': `pub mod models;
mod util { pub fn helper() {} pub struct Inner; }
pub fn top() {}
extern crate serde as sd;`,
  'src/models.rs': `pub struct User { id: u32 }
pub mod nested { pub fn load() {} }
fn private_helper() {}`,
};
const CRATE = crateOf(FILES);
const ENV: RustNameEnvironment = { externs: new Set(['serde']), repoCrates: new Map() };

function resolve(
  text: string,
  ns: 'type' | 'value' | 'macro' = 'value',
  from: RustModuleNode = CRATE.root,
  crate: RustCrateIndex = CRATE,
  env: RustNameEnvironment = ENV,
): unknown {
  return resolvePath(path(text), ns, from, crate, env);
}

describe('buildCrateIndex', () => {
  it('builds file modules and inline modules into one tree', () => {
    expect(CRATE.root.children.get('models')?.file).toBe('src/models.rs');
    expect(child(CRATE.root, 'util').inline).toBe(true);
    expect(child(child(CRATE.root, 'models'), 'nested').path).toBe('models::nested');
  });

  it('reads the extern crate aliases at the crate root', () => {
    expect(CRATE.externCrates.get('sd')).toBe('serde');
  });
});

describe('resolvePath: crate, self and super', () => {
  it('resolves crate:: to a local item', () => {
    expect(resolve('crate::top')).toEqual({ kind: 'symbol', id: 'src/lib.rs:top' });
  });

  it('resolves through file modules to their items', () => {
    expect(resolve('crate::models::User', 'type')).toEqual({
      kind: 'symbol',
      id: 'src/models.rs:User',
    });
  });

  it('resolves through nested inline modules in a file module', () => {
    expect(resolve('crate::models::nested::load')).toEqual({
      kind: 'symbol',
      id: 'src/models.rs:nested::load',
    });
  });

  it('resolves self:: and super:: relative to the current module', () => {
    const util = child(CRATE.root, 'util');
    expect(resolve('self::util::Inner', 'type')).toEqual({
      kind: 'symbol',
      id: 'src/lib.rs:util::Inner',
    });
    expect(resolve('super::top', 'value', util)).toEqual({ kind: 'symbol', id: 'src/lib.rs:top' });
  });

  it('reports super past the crate root as unresolved', () => {
    const util = child(CRATE.root, 'util');
    expect(resolve('super::super::top', 'value', util)).toMatchObject({
      kind: 'unresolved',
      reason: 'unresolved-module-path',
      subject: 'super::super::top',
    });
  });

  it('reports a missing name in a local module as unresolved', () => {
    expect(resolve('crate::nope::x')).toMatchObject({
      kind: 'unresolved',
      reason: 'unresolved-module-path',
      subject: 'crate::nope::x',
    });
  });
});

describe('resolvePath: uniform paths and extern crates', () => {
  it('resolves a first segment that is a local module', () => {
    expect(resolve('models::User', 'type')).toEqual({ kind: 'symbol', id: 'src/models.rs:User' });
  });

  it('resolves an extern crate through its alias', () => {
    expect(resolve('sd::Deserialize', 'type')).toEqual({ kind: 'extern', crate: 'serde' });
  });

  it('resolves a crate that is named directly', () => {
    expect(resolve('serde::Serialize', 'type')).toEqual({ kind: 'extern', crate: 'serde' });
  });

  it('resolves the standard crates without any extern table entry', () => {
    expect(resolve('std::fs::read')).toEqual({ kind: 'extern', crate: 'std' });
  });

  it('resolves a leading :: to an extern crate in edition 2018 and later', () => {
    expect(resolve('::serde::Serialize', 'type')).toEqual({ kind: 'extern', crate: 'serde' });
  });

  it('reports a local item and an extern crate with the same name as unresolved', () => {
    const crate = crateOf({ 'src/lib.rs': 'mod serde { pub fn f() {} }' });
    expect(resolve('serde::f', 'value', crate.root, crate, ENV)).toMatchObject({
      kind: 'unresolved',
      reason: 'unresolved-module-path',
    });
  });

  it('treats a name the crate does not know as not-found, not as an observation', () => {
    expect(resolve('Vec::new')).toEqual({ kind: 'not-found' });
  });

  it('resolves to a file module with no item of its own', () => {
    expect(resolve('models', 'type')).toEqual({ kind: 'file', path: 'src/models.rs' });
  });

  it('continues past a type into its associated items', () => {
    const crate = crateOf({
      'src/lib.rs':
        'pub struct User { x: u8 } impl User { pub fn new() -> User { User { x: 0 } } }',
    });
    expect(resolve('User::new', 'value', crate.root, crate, NO_EXTERNS)).toEqual({
      kind: 'associated',
      id: 'src/lib.rs:User',
      rest: ['new'],
    });
  });
});

describe('resolvePath: other repository crates', () => {
  it('resolves through a crate that is in the repository', () => {
    const ingest = crateOf(
      { 'crates/ingest/src/lib.rs': 'pub fn build() {}' },
      'crates/ingest/src/lib.rs',
    );
    const env: RustNameEnvironment = {
      externs: new Set(),
      repoCrates: new Map([['ingest', ingest]]),
    };
    expect(resolve('ingest::build', 'value', CRATE.root, CRATE, env)).toEqual({
      kind: 'symbol',
      id: 'crates/ingest/src/lib.rs:build',
    });
  });
});
