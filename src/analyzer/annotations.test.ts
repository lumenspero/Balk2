import { describe, expect, it } from 'vitest';
import { JsTsAnalyzer } from './js-ts-analyzer.js';
import { applyAnnotations, type Annotation } from './annotations.js';
import { normalizeAnnotations } from '../config/annotations-config.js';
import { ConnectionGraph } from '../graph.js';
import { createRepositoryFixture } from '../testing/repository-fixture.js';

const OPTIONS = { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' };
const META = { generatedAt: '2026-01-01T00:00:00Z' };

const FILES: Record<string, string> = {
  'util.ts': 'export function help(): number { return 1; }',
  'main.ts': [
    "import { help } from './util.js';",
    'export function run(): number { return help(); }',
  ].join('\n'),
};

function analyzed(): ConnectionGraph {
  const fixture = createRepositoryFixture(FILES, OPTIONS);
  try {
    const graph = new ConnectionGraph();
    new JsTsAnalyzer().analyzeRepository(fixture.repository, graph, {});
    return graph;
  } finally {
    fixture.cleanup();
  }
}

const CALL: Annotation = {
  type: 'calls',
  from: 'main.ts:run',
  to: 'util.ts:help',
  confidence: 'low',
};

describe('annotations override an existing relationship', () => {
  it('sets the confidence of a matching edge and marks it as annotated', () => {
    const graph = analyzed();
    const problems = applyAnnotations(graph, [CALL]);

    expect(problems).toEqual([]);
    const edge = graph
      .getRelationships()
      .find(
        (rel) => rel.type === 'calls' && rel.from === 'main.ts:run' && rel.to === 'util.ts:help',
      );
    expect(edge).toMatchObject({
      confidence: 'low',
      evidence: 'config',
      metadata: { annotated: true },
    });
  });

  it('never creates a relationship that the analysis did not find', () => {
    const graph = analyzed();
    const before = graph.relationshipCount;
    const problems = applyAnnotations(graph, [
      { type: 'calls', from: 'main.ts', to: 'util.ts:help', confidence: 'high' },
    ]);

    expect(graph.relationshipCount).toBe(before);
    expect(problems.map((problem) => problem.message)).toEqual([
      'no calls relationship from main.ts to util.ts:help; annotation ignored',
    ]);
  });

  it('does not change a link to an unresolved observation', () => {
    const graph = analyzed();
    graph.addUnresolved({
      reason: 'dynamic-registry-key',
      attempted: 'calls',
      subject: 'run()',
      location: { filePath: 'main.ts', startLine: 2, startColumn: 1, endLine: 2, endColumn: 5 },
    });
    const unresolvedId = 'unresolved:dynamic-registry-key:main.ts:2:1';
    graph.addRelationship('calls', 'main.ts:run', unresolvedId, 'low');

    const problems = applyAnnotations(graph, [
      { type: 'calls', from: 'main.ts:run', to: unresolvedId, confidence: 'high' },
    ]);

    const edge = graph.getRelationships().find((rel) => rel.to === unresolvedId);
    expect(edge?.confidence).toBe('low');
    expect(problems.map((problem) => problem.message)).toEqual([
      `calls to ${unresolvedId} is an unresolved observation; annotation ignored`,
    ]);
  });

  it('records each annotated edge in the built map with its provenance', () => {
    const graph = analyzed();
    applyAnnotations(graph, [CALL]);
    const map = graph.build(META);
    expect(map.relationships).toContainEqual(
      expect.objectContaining({
        type: 'calls',
        from: 'main.ts:run',
        to: 'util.ts:help',
        metadata: { annotated: true },
      }),
    );
  });
});

describe('annotations configuration', () => {
  it('accepts a complete annotation', () => {
    const problems: Array<{ path: string; message: string }> = [];
    const result = normalizeAnnotations(
      [{ type: 'calls', from: 'main.ts:run', to: 'util.ts:help', confidence: 'low' }],
      problems,
    );
    expect(problems).toEqual([]);
    expect(result).toEqual([CALL]);
  });

  it('rejects an annotation without a confidence, since it would change nothing', () => {
    const problems: Array<{ path: string; message: string }> = [];
    const result = normalizeAnnotations(
      [{ type: 'calls', from: 'main.ts:run', to: 'util.ts:help' }],
      problems,
    );
    expect(result).toBeUndefined();
    expect(problems.map((problem) => problem.path)).toEqual(['annotations[0].confidence']);
  });

  it('rejects an unknown confidence value', () => {
    const problems: Array<{ path: string; message: string }> = [];
    normalizeAnnotations(
      [{ type: 'calls', from: 'main.ts:run', to: 'util.ts:help', confidence: 'certain' }],
      problems,
    );
    expect(problems.map((problem) => problem.path)).toEqual(['annotations[0].confidence']);
  });
});
