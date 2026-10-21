import { describe, expect, it } from 'vitest';
import { ConnectionGraph } from '../graph.js';
import { detectArtifactFormat, registerDataArtifacts } from './formats.js';
import { detectManifestKind, registerManifests } from './manifests.js';

describe('detectManifestKind', () => {
  it.each([
    ['package.json', 'npm-manifest'],
    ['packages/ui/package.json', 'npm-manifest'],
    ['tsconfig.json', 'npm-manifest'],
    ['tsconfig.build.json', 'npm-manifest'],
    ['pyproject.toml', 'python-manifest'],
    ['setup.cfg', 'python-manifest'],
    ['ruff.toml', 'python-manifest'],
    ['mypy.ini', 'python-manifest'],
    ['Cargo.toml', 'cargo-manifest'],
    ['crates/ingest/Cargo.toml', 'cargo-manifest'],
    ['cargo.toml', 'cargo-manifest'],
    ['rust-toolchain.toml', 'cargo-manifest'],
    ['rustfmt.toml', 'cargo-manifest'],
    ['clippy.toml', 'cargo-manifest'],
    ['.cargo/config.toml', 'cargo-manifest'],
    ['crates/a/.cargo/config.toml', 'cargo-manifest'],
  ] as const)('tags %s as %s', (path, kind) => {
    expect(detectManifestKind(path)).toBe(kind);
  });

  it('leaves ordinary data and source files alone', () => {
    expect(detectManifestKind('config/app.toml')).toBeUndefined();
    expect(detectManifestKind('data/items.json')).toBeUndefined();
    expect(detectManifestKind('src/tsconfig-loader.ts')).toBeUndefined();
    expect(detectManifestKind('schemas/tsconfig.schema.json')).toBeUndefined();
    expect(detectManifestKind('src/cargo.rs')).toBeUndefined();
  });
});

describe('manifests are not data artifacts (V3 Phase 1.4)', () => {
  const files = ['Cargo.toml', 'pyproject.toml', 'package.json', 'config/app.toml', 'data/a.json'];

  it('registerDataArtifacts leaves manifests out and keeps other data', () => {
    const graph = new ConnectionGraph();
    registerDataArtifacts(files, graph);
    const map = graph.build({ generatedAt: '2026-01-01T00:00:00Z' });
    expect(Object.keys(map.artifacts)).toEqual(['config/app.toml', 'data/a.json']);
  });

  it('registerManifests adds a tagged file node for each manifest', () => {
    const graph = new ConnectionGraph();
    expect(registerManifests(files, graph)).toEqual([
      'Cargo.toml',
      'pyproject.toml',
      'package.json',
    ]);
    const map = graph.build({ generatedAt: '2026-01-01T00:00:00Z' });
    expect(Object.values(map.files).map((f) => [f.path, f.language])).toEqual([
      ['Cargo.toml', 'cargo-manifest'],
      ['package.json', 'npm-manifest'],
      ['pyproject.toml', 'python-manifest'],
    ]);
  });

  it('keeps the artifact format of a manifest that code reads as data', () => {
    // Reads of a manifest still create a data edge, through the artifact format.
    expect(detectArtifactFormat('Cargo.toml')).toBe('toml');
  });
});
