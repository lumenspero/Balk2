import { describe, expect, it } from 'vitest';
import { buildModuleTree, type ModuleTree } from './tree.js';

function tree(files: Record<string, string>, crateRoots: readonly string[]): ModuleTree {
  return buildModuleTree({
    crateRoots,
    files: new Set(Object.keys(files)),
    readText: (path) => files[path] ?? '',
  });
}

describe('buildModuleTree', () => {
  it('follows declarations from the crate root through child files', () => {
    const result = tree(
      { 'src/lib.rs': 'mod foo;', 'src/foo.rs': 'mod bar;', 'src/foo/bar.rs': '' },
      ['src/lib.rs'],
    );
    expect(result.edges).toEqual([
      { from: 'src/lib.rs', to: 'src/foo.rs', cfg: null },
      { from: 'src/foo.rs', to: 'src/foo/bar.rs', cfg: null },
    ]);
    expect(result.files).toEqual(['src/foo.rs', 'src/foo/bar.rs', 'src/lib.rs']);
  });

  it('records the cfg of a declaration and of its enclosing inline modules', () => {
    const result = tree(
      {
        'src/lib.rs':
          '#[cfg(unix)] mod a; #[cfg(all(unix, not(target_os = "macos")))] mod inline { mod b; }',
        'src/a.rs': '',
        'src/inline/b.rs': '',
      },
      ['src/lib.rs'],
    );
    expect(result.edges).toEqual([
      { from: 'src/lib.rs', to: 'src/a.rs', cfg: 'cfg(unix)' },
      {
        from: 'src/lib.rs',
        to: 'src/inline/b.rs',
        cfg: 'cfg(all(unix, not(target_os = "macos")))',
      },
    ]);
  });

  it('joins several cfg attributes on one declaration with and', () => {
    const result = tree({ 'src/lib.rs': '#[cfg(unix)] #[cfg(not(test))] mod c;', 'src/c.rs': '' }, [
      'src/lib.rs',
    ]);
    expect(result.edges).toEqual([
      { from: 'src/lib.rs', to: 'src/c.rs', cfg: 'cfg(unix) and cfg(not(test))' },
    ]);
  });

  it('draws one edge per candidate for cfg twins', () => {
    const result = tree(
      {
        'src/lib.rs': '#[cfg(unix)] mod imp; #[cfg(windows)] #[path = "imp_win.rs"] mod imp;',
        'src/imp.rs': '',
        'src/imp_win.rs': '',
      },
      ['src/lib.rs'],
    );
    expect(result.edges).toEqual([
      { from: 'src/lib.rs', to: 'src/imp.rs', cfg: 'cfg(unix)' },
      { from: 'src/lib.rs', to: 'src/imp_win.rs', cfg: 'cfg(windows)' },
    ]);
  });

  it('reads #[path] values with escaped and raw strings', () => {
    const result = tree(
      {
        'src/lib.rs': '#[path = "gen\\\\x.rs"] mod a; #[path = r"raw/y.rs"] mod b;',
        'src/gen/x.rs': '',
        'src/raw/y.rs': '',
      },
      ['src/lib.rs'],
    );
    expect(result.edges.map((edge) => edge.to)).toEqual(['src/gen/x.rs', 'src/raw/y.rs']);
  });

  it('treats a file loaded through #[path] as mod-rs for its own children', () => {
    const result = tree(
      {
        'src/lib.rs': '#[path = "gen/x.rs"] mod x;',
        'src/gen/x.rs': 'mod y;',
        'src/gen/y.rs': '',
      },
      ['src/lib.rs'],
    );
    expect(result.edges).toEqual([
      { from: 'src/lib.rs', to: 'src/gen/x.rs', cfg: null },
      { from: 'src/gen/x.rs', to: 'src/gen/y.rs', cfg: null },
    ]);
  });

  it('draws no edge for a missing file or for two candidate files', () => {
    const result = tree(
      {
        'src/lib.rs': 'mod missing; mod both;',
        'src/both.rs': '',
        'src/both/mod.rs': '',
      },
      ['src/lib.rs'],
    );
    expect(result.edges).toEqual([]);
    expect(result.files).toEqual(['src/lib.rs']);
  });

  it('terminates on a cycle through #[path]', () => {
    const result = tree({ 'src/lib.rs': 'mod a;', 'src/a.rs': '#[path = "lib.rs"] mod back;' }, [
      'src/lib.rs',
    ]);
    expect(result.edges).toEqual([
      { from: 'src/lib.rs', to: 'src/a.rs', cfg: null },
      { from: 'src/a.rs', to: 'src/lib.rs', cfg: null },
    ]);
    expect(result.files).toEqual(['src/a.rs', 'src/lib.rs']);
  });

  it('ignores files that no crate root reaches', () => {
    const result = tree({ 'src/lib.rs': '', 'src/orphan.rs': 'mod x;', 'src/x.rs': '' }, [
      'src/lib.rs',
    ]);
    expect(result.edges).toEqual([]);
    expect(result.files).toEqual(['src/lib.rs']);
  });

  it('ignores crate roots that are not in the file set', () => {
    const result = tree({}, ['src/missing.rs']);
    expect(result).toEqual({ edges: [], files: [] });
  });
});
