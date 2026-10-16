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

  it('records open() with no mode argument as a read with high confidence', () => {
    const edges = dataEdges('scripts/inspect.py', "f = open('data/in.json')\n");
    expect(edges).toEqual(['consumes scripts/inspect.py -> data/in.json high']);
  });

  it('records a path given as a default argument on a def line', () => {
    const edges = dataEdges(
      'scripts/inspect.py',
      'def load_titles(path="dist/titles.parquet"):\n    return pd.read_parquet(path)\n',
    );
    expect(edges).toEqual(['consumes scripts/inspect.py -> dist/titles.parquet high']);
  });

  it('joins pathlib pieces into one relative path and drops the bare piece', () => {
    const edges = dataEdges(
      'scripts/inspect.py',
      'data = pd.read_json(root_dir / "data" / "targets" / "x.json")\n',
    );
    expect(edges).toEqual(['consumes scripts/inspect.py -> data/targets/x.json high']);
  });

  it('joins os.path.join arguments into one relative path', () => {
    const edges = dataEdges(
      'scripts/inspect.py',
      "with open(os.path.join(base, 'data', 'raw.json')) as f:\n    pass\n",
    );
    expect(edges).toEqual(['consumes scripts/inspect.py -> data/raw.json high']);
  });

  it('treats a path built from an output directory as a low-confidence write', () => {
    const edges = dataEdges(
      'scripts/collect.py',
      'out_file = self.output_dir / "target_15k_app_ids.json"\n',
    );
    expect(edges).toEqual(['generates scripts/collect.py -> target_15k_app_ids.json low']);
  });

  it('ignores a URL', () => {
    const edges = dataEdges(
      'scripts/inspect_r2.py',
      "df = pd.read_parquet('https://cdn.example.dev/v1/titles.parquet')\n",
    );
    expect(edges).toEqual([]);
  });

  it('ignores a template with a placeholder', () => {
    const edges = dataEdges(
      'scripts/collect.py',
      "with open(f'steamspy_page_{page}.json', 'w') as f:\n    pass\n",
    );
    expect(edges).toEqual([]);
  });

  it('ignores label text that contains whitespace', () => {
    const edges = dataEdges('scripts/notes.py', 'NOTE = "[data/raw.json] build.py | output"\n');
    expect(edges).toEqual([]);
  });
});
