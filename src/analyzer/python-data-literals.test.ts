import { describe, expect, it } from 'vitest';
import { ConnectionGraph } from '../graph.js';
import { PythonAnalyzer } from './python-analyzer.js';

const DATA_RELATIONSHIPS = ['generates', 'consumes', 'reads'];

function dataEdges(filePath: string, code: string): string[] {
  const graph = new ConnectionGraph();
  new PythonAnalyzer().analyzeFile(filePath, code, graph);
  const map = graph.build({ generatedAt: 'test' });
  return map.relationships
    .filter((rel) => DATA_RELATIONSHIPS.includes(rel.type))
    .map((rel) => `${rel.type} ${rel.from} -> ${rel.to} ${rel.confidence}`);
}

describe('python data artifact literals', () => {
  it('records a path opened for writing with high confidence', () => {
    const edges = dataEdges(
      'scripts/collect.py',
      "with open('out/report.json', 'w') as f:\n    pass\n",
    );
    expect(edges).toEqual(['generates scripts/collect.py -> out/report.json high']);
  });

  it('records a path loaded with a read keyword with high confidence', () => {
    const edges = dataEdges('scripts/load.py', "data = json.load(open('data/raw.json'))\n");
    expect(edges).toEqual(['consumes scripts/load.py -> data/raw.json high']);
  });

  it('records a path with no read or write context at low confidence', () => {
    const edges = dataEdges(
      'scripts/paths.py',
      "CONFIG = os.path.join(base, 'connection-map/report.json')\n",
    );
    expect(edges).toEqual(['reads scripts/paths.py -> connection-map/report.json low']);
  });

  it('ignores an extension used in an endswith check', () => {
    const edges = dataEdges('scripts/check.py', "if name.endswith('.json'):\n    pass\n");
    expect(edges).toEqual([]);
  });

  it('ignores a data path that is only compared', () => {
    const edges = dataEdges('scripts/check.py', "if mode == 'out/report.json':\n    pass\n");
    expect(edges).toEqual([]);
  });

  it('ignores label text that contains whitespace', () => {
    const edges = dataEdges('scripts/notes.py', 'NOTE = "[data/raw.json] build.py | output"\n');
    expect(edges).toEqual([]);
  });
});
