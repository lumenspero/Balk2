import { describe, expect, it } from 'vitest';
import { ConnectionGraph } from '../graph.js';
import { JsTsAnalyzer } from './js-ts-analyzer.js';

const DATA_RELATIONSHIPS = ['generates', 'consumes', 'reads'];

function dataFactsOf(
  filePath: string,
  code: string,
): { artifacts: string[]; edges: string[] } {
  const graph = new ConnectionGraph();
  new JsTsAnalyzer().analyzeFile(filePath, code, graph, { knownFiles: [] });
  const map = graph.build({ generatedAt: 'test' });
  return {
    artifacts: Object.keys(map.artifacts),
    edges: map.relationships
      .filter((rel) => DATA_RELATIONSHIPS.includes(rel.type))
      .map((rel) => `${rel.type} ${rel.from} -> ${rel.to}`),
  };
}

describe('data artifact literals', () => {
  it('ignores a label string that ends in a data extension but contains whitespace', () => {
    const facts = dataFactsOf(
      'src/renderer/paths.test.ts',
      "const expected = '[data/raw.json] build.js | → consumes → | data/raw.json';",
    );
    expect(facts.artifacts).toEqual([]);
    expect(facts.edges).toEqual([]);
  });

  it('still records a plain data path that the code reads', () => {
    const facts = dataFactsOf('scripts/reader.js', "fs.readFileSync('data/raw.json', 'utf8');");
    expect(facts.artifacts).toContain('data/raw.json');
    expect(facts.edges).toEqual(['consumes scripts/reader.js -> data/raw.json']);
  });
});
