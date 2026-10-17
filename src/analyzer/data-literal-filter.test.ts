import { describe, expect, it } from 'vitest';
import { ConnectionGraph } from '../graph.js';
import { JsTsAnalyzer } from './js-ts-analyzer.js';

const DATA_RELATIONSHIPS = ['generates', 'consumes', 'reads'];

function dataFactsOf(filePath: string, code: string): { artifacts: string[]; edges: string[] } {
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

function dataEdgesWithConfidence(filePath: string, code: string): string[] {
  const graph = new ConnectionGraph();
  new JsTsAnalyzer().analyzeFile(filePath, code, graph, { knownFiles: [] });
  const map = graph.build({ generatedAt: 'test' });
  return map.relationships
    .filter((rel) => DATA_RELATIONSHIPS.includes(rel.type))
    .map((rel) => `${rel.type} ${rel.from} -> ${rel.to} ${rel.confidence}`);
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

  it('ignores a web-root path, which the app serves rather than the repository', () => {
    const facts = dataFactsOf('src/app.ts', "fetch('/manifest.json').then((r) => r.json());");
    expect(facts.artifacts).toEqual([]);
    expect(facts.edges).toEqual([]);
  });

  it('ignores a bare extension passed to an access call, which names no file', () => {
    const facts = dataFactsOf('scripts/reader.js', "fs.readFileSync('.json', 'utf8');");
    expect(facts.artifacts).toEqual([]);
    expect(facts.edges).toEqual([]);
  });

  it('ignores an extension alone, as used in endsWith checks', () => {
    const facts = dataFactsOf(
      'src/cli/resolve.ts',
      "if (resolved.endsWith('.json')) return resolved.slice(0, -5);",
    );
    expect(facts.artifacts).toEqual([]);
    expect(facts.edges).toEqual([]);
  });

  it('ignores a data path that is only compared, not accessed', () => {
    const facts = dataFactsOf('src/cli/check.ts', "if (name === 'out/report.json') return true;");
    expect(facts.artifacts).toEqual([]);
  });

  it('judges a path built with path.join by the call that opens it', () => {
    const edges = dataEdgesWithConfidence(
      'scripts/writer.js',
      "fs.writeFileSync(path.join(dir, 'out/report.json'), data);",
    );
    expect(edges).toEqual(['generates scripts/writer.js -> out/report.json high']);
  });

  it('judges a path built with path.join for a read by the reading call', () => {
    const edges = dataEdgesWithConfidence(
      'scripts/loader.js',
      "fs.readFileSync(path.join(dir, 'data/in.json'), 'utf8');",
    );
    expect(edges).toEqual(['consumes scripts/loader.js -> data/in.json high']);
  });

  it('joins a path.join with trailing literal pieces into one relative path', () => {
    const edges = dataEdgesWithConfidence(
      'scripts/load.js',
      "fs.readFileSync(path.join(root, 'data', 'raw', 'x.json'), 'utf8');",
    );
    expect(edges).toEqual(['consumes scripts/load.js -> data/raw/x.json high']);
  });

  it('judges a joined write by the call that writes it', () => {
    const edges = dataEdgesWithConfidence(
      'scripts/write.js',
      "fs.writeFileSync(path.join(dir, 'out', 'x.json'), data);",
    );
    expect(edges).toEqual(['generates scripts/write.js -> out/x.json high']);
  });

  it('records nothing for a joined path that leaves the repository', () => {
    const edges = dataEdgesWithConfidence(
      'scripts/outside.js',
      "fs.readFileSync(path.join(__dirname, '..', 'data', 'x.json'));",
    );
    expect(edges).toEqual([]);
  });

  it('records a path with no read or write context at low confidence', () => {
    const edges = dataEdgesWithConfidence(
      'src/cli/generate.ts',
      "const jsonPath = path.join(rootDir, 'connection-map/report.json');",
    );
    expect(edges).toEqual(['reads src/cli/generate.ts -> connection-map/report.json low']);
  });
});
