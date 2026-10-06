import { describe, it, expect } from 'vitest';
import { ConnectionGraph, normalizePath } from './graph.js';

describe('normalizePath', () => {
  it('converts backslashes to forward slashes', () => {
    expect(normalizePath('src\\main.ts')).toBe('src/main.ts');
  });

  it('removes leading ./', () => {
    expect(normalizePath('./src/main.ts')).toBe('src/main.ts');
  });

  it('leaves clean paths unchanged', () => {
    expect(normalizePath('src/main.ts')).toBe('src/main.ts');
  });
});

describe('ConnectionGraph', () => {
  describe('file nodes', () => {
    it('adds and retrieves a file node', () => {
      const graph = new ConnectionGraph();
      const node = graph.addFile('src/main.ts', 'typescript');

      expect(node).toEqual({ kind: 'file', path: 'src/main.ts', language: 'typescript' });
      expect(graph.hasFile('src/main.ts')).toBe(true);
      expect(graph.getFile('src/main.ts')).toEqual(node);
    });

    it('normalizes file paths', () => {
      const graph = new ConnectionGraph();
      graph.addFile('.\\src\\main.ts', 'typescript');

      expect(graph.hasFile('src/main.ts')).toBe(true);
    });

    it('omits language when not provided', () => {
      const graph = new ConnectionGraph();
      const node = graph.addFile('src/main.ts');

      expect(node).toEqual({ kind: 'file', path: 'src/main.ts' });
      expect('language' in node).toBe(false);
    });

    it('replaces existing file with same path', () => {
      const graph = new ConnectionGraph();
      graph.addFile('src/main.ts', 'javascript');
      graph.addFile('src/main.ts', 'typescript');

      expect(graph.getFile('src/main.ts')?.language).toBe('typescript');
      expect(graph.nodeCount).toBe(1);
    });
  });

  describe('symbol nodes', () => {
    it('adds and retrieves a symbol node', () => {
      const graph = new ConnectionGraph();
      const node = graph.addSymbol('src/state.ts', 'updateState', 'function');

      expect(node).toEqual({
        kind: 'symbol',
        id: 'src/state.ts:updateState',
        filePath: 'src/state.ts',
        name: 'updateState',
        symbolType: 'function',
      });
      expect(graph.hasSymbol('src/state.ts:updateState')).toBe(true);
      expect(graph.getSymbol('src/state.ts:updateState')).toEqual(node);
    });

    it('normalizes file paths in symbol ids', () => {
      const graph = new ConnectionGraph();
      graph.addSymbol('.\\src\\state.ts', 'updateState', 'function');

      expect(graph.hasSymbol('src/state.ts:updateState')).toBe(true);
    });
  });

  describe('artifact nodes', () => {
    it('adds and retrieves an artifact node', () => {
      const graph = new ConnectionGraph();
      const node = graph.addArtifact('data/source.json', 'json');

      expect(node).toEqual({ kind: 'artifact', path: 'data/source.json', format: 'json' });
      expect(graph.hasArtifact('data/source.json')).toBe(true);
      expect(graph.getArtifact('data/source.json')).toEqual(node);
    });
  });

  describe('relationships', () => {
    it('adds a relationship with default high confidence', () => {
      const graph = new ConnectionGraph();
      const rel = graph.addRelationship('imports', 'src/main.ts', 'src/util.ts');

      expect(rel).toEqual({
        type: 'imports',
        from: 'src/main.ts',
        to: 'src/util.ts',
        confidence: 'high',
      });
    });

    it('adds a relationship with explicit confidence', () => {
      const graph = new ConnectionGraph();
      const rel = graph.addRelationship('generates', 'scripts/build.py', 'data/out.json', 'medium');

      expect(rel.confidence).toBe('medium');
    });

    it('normalizes paths in relationships', () => {
      const graph = new ConnectionGraph();
      const rel = graph.addRelationship('imports', '.\\src\\main.ts', '.\\src\\util.ts');

      expect(rel.from).toBe('src/main.ts');
      expect(rel.to).toBe('src/util.ts');
    });

    it('filters relationships by node id', () => {
      const graph = new ConnectionGraph();
      graph.addRelationship('imports', 'src/main.ts', 'src/util.ts');
      graph.addRelationship('imports', 'src/main.ts', 'src/state.ts');
      graph.addRelationship('imports', 'src/panel.ts', 'src/state.ts');

      const mainRels = graph.getRelationships('src/main.ts');
      expect(mainRels).toHaveLength(2);

      const stateRels = graph.getRelationships('src/state.ts');
      expect(stateRels).toHaveLength(2);

      const utilRels = graph.getRelationships('src/util.ts');
      expect(utilRels).toHaveLength(1);
    });

    it('returns all relationships when no filter is provided', () => {
      const graph = new ConnectionGraph();
      graph.addRelationship('imports', 'src/main.ts', 'src/util.ts');
      graph.addRelationship('calls', 'src/main.ts:init', 'src/util.ts:setup');

      expect(graph.getRelationships()).toHaveLength(2);
    });
  });

  describe('counts', () => {
    it('counts all node types', () => {
      const graph = new ConnectionGraph();
      graph.addFile('src/main.ts');
      graph.addFile('src/util.ts');
      graph.addSymbol('src/main.ts', 'init', 'function');
      graph.addArtifact('data/out.json', 'json');

      expect(graph.nodeCount).toBe(4);
    });

    it('counts relationships', () => {
      const graph = new ConnectionGraph();
      graph.addRelationship('imports', 'a', 'b');
      graph.addRelationship('imports', 'b', 'c');

      expect(graph.relationshipCount).toBe(2);
    });
  });

  describe('build', () => {
    it('produces a valid ConnectionMap', () => {
      const graph = new ConnectionGraph();
      graph.addFile('src/main.ts', 'typescript');
      graph.addFile('src/util.ts', 'typescript');
      graph.addSymbol('src/main.ts', 'init', 'function');
      graph.addArtifact('data/out.json', 'json');
      graph.addRelationship('imports', 'src/main.ts', 'src/util.ts');

      const map = graph.build({ generatedAt: '2026-01-01T00:00:00Z' });

      expect(map.version).toBe(2);
      expect(map.repository.generatedAt).toBe('2026-01-01T00:00:00Z');
      expect(Object.keys(map.files)).toEqual(['src/main.ts', 'src/util.ts']);
      expect(Object.keys(map.symbols)).toEqual(['src/main.ts:init']);
      expect(Object.keys(map.artifacts)).toEqual(['data/out.json']);
      expect(map.relationships).toHaveLength(1);
    });

    it('produces deterministic output regardless of insertion order', () => {
      const graph1 = new ConnectionGraph();
      graph1.addFile('src/z.ts');
      graph1.addFile('src/a.ts');
      graph1.addRelationship('imports', 'src/z.ts', 'src/a.ts');
      graph1.addRelationship('calls', 'src/a.ts:foo', 'src/z.ts:bar');

      const graph2 = new ConnectionGraph();
      graph2.addFile('src/a.ts');
      graph2.addFile('src/z.ts');
      graph2.addRelationship('calls', 'src/a.ts:foo', 'src/z.ts:bar');
      graph2.addRelationship('imports', 'src/z.ts', 'src/a.ts');

      const meta = { generatedAt: '2026-01-01T00:00:00Z' };
      const map1 = graph1.build(meta);
      const map2 = graph2.build(meta);

      expect(JSON.stringify(map1)).toBe(JSON.stringify(map2));
    });

    it('sorts files alphabetically by path', () => {
      const graph = new ConnectionGraph();
      graph.addFile('src/zoo.ts');
      graph.addFile('src/alpha.ts');
      graph.addFile('src/middle.ts');

      const map = graph.build({ generatedAt: '2026-01-01T00:00:00Z' });
      expect(Object.keys(map.files)).toEqual(['src/alpha.ts', 'src/middle.ts', 'src/zoo.ts']);
    });

    it('sorts relationships by type then from then to', () => {
      const graph = new ConnectionGraph();
      graph.addRelationship('imports', 'b', 'a');
      graph.addRelationship('calls', 'a', 'b');
      graph.addRelationship('imports', 'a', 'b');

      const map = graph.build({ generatedAt: '2026-01-01T00:00:00Z' });
      expect(map.relationships.map((r) => `${r.type}:${r.from}:${r.to}`)).toEqual([
        'calls:a:b',
        'imports:a:b',
        'imports:b:a',
      ]);
    });

    it('includes commit hash when provided', () => {
      const graph = new ConnectionGraph();
      const map = graph.build({ commit: 'a81f32c', generatedAt: '2026-01-01T00:00:00Z' });

      expect(map.repository.commit).toBe('a81f32c');
    });
  });
});
