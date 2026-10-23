import { describe, expect, it } from 'vitest';
import { bindBuildScripts, type BuildScriptCrate, type BuildScriptEdge } from './build-scripts.js';
import { buildCrateIndex } from './module-index.js';

function crateOf(
  root: string,
  files: Record<string, string>,
  packageDir: string | undefined,
  buildScript: boolean,
): BuildScriptCrate {
  return {
    packageDir,
    buildScript,
    index: buildCrateIndex({
      root,
      files: new Set(Object.keys(files)),
      readText: (file) => files[file] ?? '',
      edition: '2021',
    }),
  };
}

function linesOf(edges: readonly BuildScriptEdge[]): string[] {
  return edges.map((edge) =>
    edge.kind === 'reads'
      ? `reads ${edge.from} -> ${edge.artifactPath} ${edge.format}`
      : `observation ${edge.reason}`,
  );
}

const BUILD = 'build.rs';

describe('bindBuildScripts: rerun-if-changed (V3 Phase 10.5)', () => {
  it('reads the file that a rerun-if-changed line names, relative to the package', () => {
    const files = {
      [BUILD]: 'fn main() {\n    println!("cargo:rerun-if-changed=data/schema.json");\n}\n',
      'data/schema.json': '{}',
    };
    const edges = bindBuildScripts([crateOf(BUILD, files, '', true)], new Set(Object.keys(files)));
    expect(linesOf(edges)).toEqual(['reads build.rs:main -> data/schema.json json']);
  });

  it('accepts the cargo:: spelling', () => {
    const files = {
      'crates/app/build.rs': 'fn main() {\n    println!("cargo::rerun-if-changed=assets/logo.svg");\n}\n',
      'crates/app/assets/logo.svg': '<svg/>',
    };
    const edges = bindBuildScripts(
      [crateOf('crates/app/build.rs', files, 'crates/app', true)],
      new Set(Object.keys(files)),
    );
    expect(linesOf(edges)).toEqual([
      'reads crates/app/build.rs:main -> crates/app/assets/logo.svg unknown',
    ]);
  });

  it('reports a path with a format placeholder as dynamic', () => {
    const files = {
      [BUILD]: 'fn main() {\n    let p = "x";\n    println!("cargo:rerun-if-changed={}", p);\n}\n',
    };
    const edges = bindBuildScripts([crateOf(BUILD, files, '', true)], new Set(Object.keys(files)));
    expect(linesOf(edges)).toEqual(['observation dynamic-include-path']);
  });

  it('reports a path that names no repository file as unresolved', () => {
    const files = {
      [BUILD]: 'fn main() {\n    println!("cargo:rerun-if-changed=missing.txt");\n}\n',
    };
    const edges = bindBuildScripts([crateOf(BUILD, files, '', true)], new Set(Object.keys(files)));
    expect(linesOf(edges)).toEqual(['observation unresolved-module-path']);
  });

  it('draws no edge for a print that is not a rerun line', () => {
    const files = {
      [BUILD]: 'fn main() {\n    println!("building");\n}\n',
      'data/schema.json': '{}',
    };
    const edges = bindBuildScripts([crateOf(BUILD, files, '', true)], new Set(Object.keys(files)));
    expect(edges).toEqual([]);
  });

  it('draws no edge for a rerun line outside a build script', () => {
    const files = {
      'src/lib.rs': 'pub fn main() {\n    println!("cargo:rerun-if-changed=data/schema.json");\n}\n',
      'data/schema.json': '{}',
    };
    const edges = bindBuildScripts([crateOf('src/lib.rs', files, '', false)], new Set(Object.keys(files)));
    expect(edges).toEqual([]);
  });
});
