import { describe, expect, it } from 'vitest';
import { JsTsAnalyzer } from '../analyzer/js-ts-analyzer.js';
import { ConnectionGraph } from '../graph.js';
import { withReverseLinksOnly, withStoredReverseLinks } from '../testing/legacy-maps.js';
import type { ConnectionMap } from '../types.js';
import { renderMarkdown } from './markdown-renderer.js';

const META = { commit: 'abc1234', generatedAt: '2026-01-01T00:00:00Z' };

function forwardMap(): ConnectionMap {
  const graph = new ConnectionGraph();
  const analyzer = new JsTsAnalyzer();
  const knownFiles = ['src/sim.ts', 'src/state.ts', 'src/main.ts'];
  analyzer.analyzeFile('src/sim.ts', 'export function stepSim() { return 42; }', graph, {
    knownFiles,
  });
  analyzer.analyzeFile(
    'src/state.ts',
    "import { stepSim } from './sim.js';\nexport function updateState() { stepSim(); }",
    graph,
    { knownFiles },
  );
  analyzer.analyzeFile(
    'src/main.ts',
    "import { updateState } from './state.js';\nexport function main() { updateState(); }",
    graph,
    { knownFiles },
  );

  graph.addArtifact('data/raw.json', 'json');
  graph.addArtifact('data/titles.parquet', 'parquet');
  graph.addRelationship('generates', 'scripts/collect.js', 'data/raw.json');
  graph.addRelationship('consumes', 'scripts/build.js', 'data/raw.json');
  graph.addRelationship('generates', 'scripts/build.js', 'data/titles.parquet');
  graph.addRelationship('consumes', 'src/load.ts', 'data/titles.parquet');
  return graph.build(META);
}

describe('rendering does not depend on how reverse links are stored', () => {
  const forward = renderMarkdown(forwardMap());

  it('renders a version 1 style map, with both directions stored, exactly like a forward-only one', () => {
    expect(renderMarkdown(withStoredReverseLinks(forwardMap()))).toBe(forward);
  });

  it('renders a map holding only reverse links exactly like a forward-only one', () => {
    expect(renderMarkdown(withReverseLinksOnly(forwardMap()))).toBe(forward);
  });

  it('still shows who imports and who calls each node', () => {
    expect(forward).toContain(
      '### src/state.ts (typescript)\n\nImports:\n  → src/sim.ts\nImported by:\n  ← src/main.ts',
    );
    expect(forward).toContain(
      '### src/state.ts:updateState [function]\n\nCalls:\n  → src/sim.ts:stepSim\nCalled by:\n  ← src/main.ts:main',
    );
  });

  it('counts each fact once in the overview', () => {
    const relationships = (markdown: string): string | undefined =>
      /\*\*Relationships\*\*: (\d+)/.exec(markdown)?.[1];

    expect(relationships(renderMarkdown(withStoredReverseLinks(forwardMap())))).toBe(
      relationships(forward),
    );
  });
});
