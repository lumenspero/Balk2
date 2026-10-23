import { describe, expect, it } from 'vitest';
import { computeExports, type ExportEdge } from './exports.js';
import { buildCrateIndex, type RustCrateIndex } from './module-index.js';
import { bindImports } from './imports.js';

function crateOf(files: Record<string, string>): RustCrateIndex {
  const crate = buildCrateIndex({
    root: 'src/lib.rs',
    files: new Set(Object.keys(files)),
    readText: (file) => files[file] ?? '',
    edition: '2021',
  });
  bindImports(crate, { externs: new Set(), repoCrates: new Map() });
  return crate;
}

function exported(files: Record<string, string>): ExportEdge[] {
  return computeExports(crateOf(files));
}

function ids(edges: ExportEdge[]): string[] {
  return edges.map((edge) => edge.id);
}

describe('computeExports', () => {
  it('exports public items of the crate root, and not pub(crate) or private ones', () => {
    const edges = exported({
      'src/lib.rs':
        'pub fn api() {} pub(crate) fn internal() {} fn private() {} pub struct Public;',
    });
    expect(ids(edges)).toEqual(['src/lib.rs:Public', 'src/lib.rs:api']);
    expect(edges.every((edge) => edge.from === 'src/lib.rs')).toBe(true);
  });

  it('follows pub mod into a file, and does not follow a private module', () => {
    const edges = exported({
      'src/lib.rs': 'pub mod models; mod hidden;',
      'src/models.rs': 'pub struct User; struct Internal;',
      'src/hidden.rs': 'pub struct Secret;',
    });
    expect(edges).toEqual([{ from: 'src/models.rs', id: 'src/models.rs:User' }]);
  });

  it('exports an inline pub module and its public items', () => {
    expect(
      ids(exported({ 'src/lib.rs': 'pub mod api { pub fn go() {} fn hidden() {} }' })),
    ).toEqual(['src/lib.rs:api', 'src/lib.rs:api::go']);
  });

  it('exports a symbol brought in by pub use, even from a private module', () => {
    const edges = exported({
      'src/lib.rs': 'mod internal { pub struct Deep; } pub use internal::Deep;',
    });
    expect(edges).toEqual([{ from: 'src/lib.rs', id: 'src/lib.rs:internal::Deep' }]);
  });

  it('exports the public contents of a glob re-export, from a private source', () => {
    const edges = exported({
      'src/lib.rs': 'mod inner { pub struct A; pub(crate) struct B; } pub use inner::*;',
    });
    expect(ids(edges)).toEqual(['src/lib.rs:inner::A']);
  });

  it('exports the public contents of a module brought in by pub use', () => {
    const edges = exported({
      'src/lib.rs': 'mod internal { pub mod deep { pub fn f() {} } } pub use internal::deep;',
    });
    expect(ids(edges)).toEqual(['src/lib.rs:internal::deep::f']);
  });

  it('exports nothing from a private module, even when its items are declared pub', () => {
    expect(
      exported({ 'src/lib.rs': 'mod a { pub mod b { pub fn f() {} } pub fn g() {} }' }),
    ).toEqual([]);
  });

  it('exports a #[no_mangle] function whatever its visibility', () => {
    expect(exported({ 'src/lib.rs': '#[no_mangle] extern "C" fn private_api() {}' })).toEqual([
      { from: 'src/lib.rs', id: 'src/lib.rs:private_api' },
    ]);
  });
});
