import { describe, expect, it } from 'vitest';
import { bindIncludes, type IncludeCrate, type IncludeEdge } from './includes.js';
import { buildCrateIndex } from './module-index.js';

/** Builds one crate from its files, with the package directory the crate's `Cargo.toml` implies. */
function crateOf(root: string, files: Record<string, string>, packageDir: string | undefined): IncludeCrate {
  return {
    packageDir,
    packageId: `package:cargo:${packageDir ?? ''}#lib:app`,
    index: buildCrateIndex({
      root,
      files: new Set(Object.keys(files)),
      readText: (file) => files[file] ?? '',
      edition: '2021',
    }),
  };
}

/** Each edge as one readable line, so a test shows the whole outcome at a glance. */
function linesOf(edges: readonly IncludeEdge[]): string[] {
  return edges.map((edge) => {
    switch (edge.kind) {
      case 'imports':
        return `imports ${edge.from} -> ${edge.to}`;
      case 'uses':
        return `uses ${edge.from} -> ${edge.resourcePath} ${edge.resourceKind}`;
      case 'consumes':
        return `consumes ${edge.from} -> ${edge.artifactPath} ${edge.format}`;
      case 'observation':
        return `observation ${edge.attempted} ${edge.reason}`;
      case 'build-output':
        return `build-output ${edge.from}`;
    }
  });
}

/** Runs the engine over one crate at `src/lib.rs`, with the repository files given. */
function includesOf(source: string, extra: Record<string, string> = {}, packageDir: string | undefined = ''): string[] {
  const files = { 'src/lib.rs': source, ...extra };
  const crate = crateOf('src/lib.rs', files, packageDir);
  return linesOf(bindIncludes([crate], new Set(Object.keys(files))));
}

describe('bindIncludes: include_str! and include_bytes! (V3 Phase 10.4)', () => {
  it('consumes a data file with its format, relative to the file that holds the macro', () => {
    expect(
      includesOf('pub fn load() -> &\'static str { include_str!("data/x.json") }', {
        'src/data/x.json': '{}',
      }),
    ).toEqual(['consumes src/lib.rs:load -> src/data/x.json json']);
  });

  it('gives a template a usesResource-style edge rather than a consumes edge', () => {
    expect(
      includesOf('pub const PAGE: &str = include_str!("page.html");', { 'src/page.html': '<p></p>' }),
    ).toEqual(['uses src/lib.rs:PAGE -> src/page.html template']);
  });

  it('consumes a file of no known format as unknown', () => {
    expect(
      includesOf('pub fn load() -> &\'static [u8] { include_bytes!("blob.bin") }', {
        'src/blob.bin': 'x',
      }),
    ).toEqual(['consumes src/lib.rs:load -> src/blob.bin unknown']);
  });

  it('joins plain literals in concat! relative to the file', () => {
    expect(
      includesOf('pub fn load() -> &\'static str { include_str!(concat!("data/", "x.json")) }', {
        'src/data/x.json': '{}',
      }),
    ).toEqual(['consumes src/lib.rs:load -> src/data/x.json json']);
  });

  it('resolves concat! with env!("CARGO_MANIFEST_DIR") from the package directory', () => {
    const files = {
      'crates/app/src/lib.rs':
        'pub fn load() -> &\'static str { include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/data/x.json")) }',
      'crates/app/data/x.json': '{}',
    };
    const crate = crateOf('crates/app/src/lib.rs', files, 'crates/app');
    expect(linesOf(bindIncludes([crate], new Set(Object.keys(files))))).toEqual([
      'consumes crates/app/src/lib.rs:load -> crates/app/data/x.json json',
    ]);
  });
});

describe('bindIncludes: include! (V3 Phase 10.4)', () => {
  it('imports the included file from the including file, at module level', () => {
    expect(includesOf('include!("gen.rs");', { 'src/gen.rs': 'pub fn g() {}' })).toEqual([
      'imports src/lib.rs -> src/gen.rs',
    ]);
  });
});

describe('bindIncludes: observations (V3 Phase 10.4)', () => {
  it('reports a path that is a variable as dynamic', () => {
    expect(includesOf('pub fn load(p: &str) -> &\'static str { include_str!(p) }')).toEqual([
      'observation consumes dynamic-include-path',
    ]);
  });

  it('reports an environment variable other than CARGO_MANIFEST_DIR or OUT_DIR as dynamic', () => {
    expect(
      includesOf('pub fn load() -> &\'static str { include_str!(concat!(env!("FOO_DIR"), "/x.txt")) }'),
    ).toEqual(['observation consumes dynamic-include-path']);
  });

  it('links an include of OUT_DIR to the package build output, not a dynamic observation', () => {
    expect(
      includesOf('include!(concat!(env!("OUT_DIR"), "/generated.rs"));', {}, ''),
    ).toEqual(['build-output package:cargo:#lib:app']);
  });

  it('reports a path that names no file in the repository as unresolved', () => {
    expect(includesOf('pub fn load() -> &\'static str { include_str!("missing.txt") }')).toEqual([
      'observation consumes unresolved-module-path',
    ]);
  });

  it('draws no edge for a macro that is not an include', () => {
    expect(includesOf('pub fn load() { foo!("data/x.json"); }', { 'src/data/x.json': '{}' })).toEqual(
      [],
    );
  });
});
