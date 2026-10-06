import { describe, it, expect } from 'vitest';
import { ConnectionGraph } from './graph.js';
import { serializeConnectionMap, deserializeConnectionMap } from './serialize.js';

describe('serializeConnectionMap', () => {
  it('serializes to indented JSON with trailing newline', () => {
    const graph = new ConnectionGraph();
    graph.addFile('src/main.ts', 'typescript');
    const map = graph.build({ generatedAt: '2026-01-01T00:00:00Z' });

    const json = serializeConnectionMap(map);

    expect(json).toContain('"version": 2');
    expect(json).toContain('"src/main.ts"');
    expect(json.endsWith('\n')).toBe(true);
  });

  it('produces deterministic output', () => {
    const graph = new ConnectionGraph();
    graph.addFile('src/b.ts');
    graph.addFile('src/a.ts');
    graph.addRelationship('imports', 'src/b.ts', 'src/a.ts');
    const map = graph.build({ generatedAt: '2026-01-01T00:00:00Z' });

    const json1 = serializeConnectionMap(map);
    const json2 = serializeConnectionMap(map);

    expect(json1).toBe(json2);
  });
});

describe('deserializeConnectionMap', () => {
  it('round-trips through serialize/deserialize', () => {
    const graph = new ConnectionGraph();
    graph.addFile('src/main.ts', 'typescript');
    graph.addFile('src/util.ts', 'typescript');
    graph.addSymbol('src/main.ts', 'init', 'function');
    graph.addArtifact('data/out.json', 'json');
    graph.addRelationship('imports', 'src/main.ts', 'src/util.ts');
    graph.addRelationship('generates', 'scripts/build.py', 'data/out.json', 'medium');

    const original = graph.build({ commit: 'abc1234', generatedAt: '2026-01-01T00:00:00Z' });
    const json = serializeConnectionMap(original);
    const restored = deserializeConnectionMap(json);

    expect(restored).toEqual(original);
  });

  it('rejects invalid version', () => {
    const bad = JSON.stringify({ version: 99 });
    expect(() => deserializeConnectionMap(bad)).toThrow('Unsupported connection map version');
  });

  it('rejects non-object input', () => {
    expect(() => deserializeConnectionMap('"hello"')).toThrow('expected an object');
  });

  it('rejects missing files', () => {
    const bad = JSON.stringify({
      version: 1,
      repository: {},
      symbols: {},
      artifacts: {},
      relationships: [],
    });
    expect(() => deserializeConnectionMap(bad)).toThrow('missing files');
  });

  it('rejects missing relationships array', () => {
    const bad = JSON.stringify({
      version: 1,
      repository: {},
      files: {},
      symbols: {},
      artifacts: {},
    });
    expect(() => deserializeConnectionMap(bad)).toThrow('missing relationships');
  });
});

describe('end-to-end graph scenario', () => {
  it('represents a multi-file pipeline with data artifacts', () => {
    const graph = new ConnectionGraph();

    // Code files
    graph.addFile('scripts/collect.py', 'python');
    graph.addFile('scripts/build.py', 'python');
    graph.addFile('src/data/loadTitles.ts', 'typescript');
    graph.addFile('src/pages/TitlesPage.tsx', 'typescript');

    // Data artifacts
    graph.addArtifact('data/raw.json', 'json');
    graph.addArtifact('data/titles.parquet', 'parquet');

    // Symbols
    graph.addSymbol('src/data/loadTitles.ts', 'loadTitles', 'function');

    // Data relationships
    graph.addRelationship('generates', 'scripts/collect.py', 'data/raw.json');
    graph.addRelationship('consumes', 'scripts/build.py', 'data/raw.json');
    graph.addRelationship('generates', 'scripts/build.py', 'data/titles.parquet');
    graph.addRelationship('consumes', 'src/data/loadTitles.ts', 'data/titles.parquet');

    // Code relationships
    graph.addRelationship('imports', 'src/pages/TitlesPage.tsx', 'src/data/loadTitles.ts');
    graph.addRelationship('calls', 'src/pages/TitlesPage.tsx', 'src/data/loadTitles.ts:loadTitles');

    const map = graph.build({ commit: 'abc1234', generatedAt: '2026-01-01T00:00:00Z' });

    // Verify structure
    expect(Object.keys(map.files)).toHaveLength(4);
    expect(Object.keys(map.artifacts)).toHaveLength(2);
    expect(Object.keys(map.symbols)).toHaveLength(1);
    expect(map.relationships).toHaveLength(6);

    // Verify round-trip
    const json = serializeConnectionMap(map);
    const restored = deserializeConnectionMap(json);
    expect(restored).toEqual(map);

    // Verify determinism
    const json2 = serializeConnectionMap(restored);
    expect(json2).toBe(json);
  });
});
