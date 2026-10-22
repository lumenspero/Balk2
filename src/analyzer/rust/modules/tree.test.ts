import { describe, expect, it } from 'vitest';
import { buildModuleTree, type ModuleTree } from './tree.js';

function tree(
  files: Record<string, string>,
  crateRoots: readonly string[],
  packageDirs: readonly string[] = [],
): ModuleTree {
  return buildModuleTree({
    crateRoots,
    packageDirs,
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
    expect(result.edges).toEqual([]);
    expect(result.files).toEqual([]);
  });

  it('reports two candidate files as a conflict and draws no edge', () => {
    const result = tree({ 'src/lib.rs': 'mod both;', 'src/both.rs': '', 'src/both/mod.rs': '' }, [
      'src/lib.rs',
    ]);
    expect(result.edges).toEqual([]);
    expect(result.conflicts).toEqual([
      {
        file: 'src/lib.rs',
        location: {
          filePath: 'src/lib.rs',
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 10,
        },
        message: 'both src/both.rs and src/both/mod.rs exist',
      },
    ]);
  });

  it('reports a declaration with no file as unresolved', () => {
    const result = tree({ 'src/lib.rs': 'mod missing;' }, ['src/lib.rs']);
    expect(result.unresolved.map((u) => [u.file, u.subject, u.detail])).toEqual([
      ['src/lib.rs', 'missing', 'no file at src/missing.rs or src/missing/mod.rs'],
    ]);
  });

  it('reports a non-string #[path] as unresolved instead of guessing', () => {
    const result = tree({ 'src/lib.rs': '#[path = 3] mod odd;', 'src/odd.rs': '' }, ['src/lib.rs']);
    expect(result.edges).toEqual([]);
    expect(result.unresolved.map((u) => u.detail)).toEqual([
      '#[path] does not have a plain string value',
    ]);
  });

  it('reports a #[path] set under cfg_attr as unresolved', () => {
    const result = tree(
      {
        'src/lib.rs': '#[cfg_attr(feature = "x", path = "z.rs")] mod c;',
        'src/c.rs': '',
        'src/z.rs': '',
      },
      ['src/lib.rs'],
    );
    expect(result.edges).toEqual([]);
    expect(result.unresolved.map((u) => u.detail)).toEqual([
      'the #[path] is set under #[cfg_attr], and conditions are not evaluated',
    ]);
  });

  it('reports an absolute #[path] as unresolved', () => {
    const result = tree({ 'src/lib.rs': '#[path = "/etc/x.rs"] mod x;' }, ['src/lib.rs']);
    expect(result.unresolved.map((u) => u.detail)).toEqual([
      'the #[path] is absolute, so it names no file in the repository',
    ]);
  });

  it('reports a Rust file in a package that no crate reaches as unreachable', () => {
    const result = tree(
      { 'src/lib.rs': '', 'src/orphan.rs': 'mod x;', 'src/x.rs': '' },
      ['src/lib.rs'],
      ['.'],
    );
    expect(result.unreachable).toEqual(['src/orphan.rs', 'src/x.rs']);
  });

  it('does not report files outside every package directory', () => {
    const result = tree({ 'src/lib.rs': '', 'scripts/tool.rs': '' }, ['src/lib.rs'], ['crates/a']);
    expect(result.unreachable).toEqual([]);
  });

  it('resolves a file that two crates reach once per crate', () => {
    // As a crate root, src/a.rs is mod-rs, so its child is src/b.rs.
    // Reached from src/lib.rs, it is non-mod-rs, so its child is src/a/b.rs.
    const result = tree(
      {
        'src/lib.rs': 'mod a;',
        'src/a.rs': 'mod b;',
        'src/a/b.rs': '',
        'src/b.rs': '',
      },
      ['src/a.rs', 'src/lib.rs'],
    );
    expect(result.edges).toContainEqual({ from: 'src/a.rs', to: 'src/b.rs', cfg: null });
    expect(result.edges).toContainEqual({ from: 'src/a.rs', to: 'src/a/b.rs', cfg: null });
    expect(result.unreachable).toEqual([]);
  });
});
