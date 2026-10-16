import { describe, expect, it } from 'vitest';
import { PythonAnalyzer } from './python-analyzer.js';
import { collectPythonSourceAnnotations } from './python-source-apply.js';
import { applyAnnotations, type Annotation } from './annotations.js';
import { ConnectionGraph } from '../graph.js';
import type { Relationship } from '../types.js';

const META = { generatedAt: '2026-01-01T00:00:00Z' };

interface RunResult {
  readonly graph: ConnectionGraph;
  readonly problems: Array<{ path: string; message: string }>;
}

/** Analyze Python files as build-graph does, then collect and apply their source directives. */
function run(files: Record<string, string>, config: readonly Annotation[] = []): RunResult {
  const knownFiles = Object.keys(files);
  const graph = new ConnectionGraph();
  for (const [path, content] of Object.entries(files)) {
    new PythonAnalyzer().analyzeFile(path, content, graph, { rootDir: '.', knownFiles });
  }
  const collected = collectPythonSourceAnnotations(files, config);
  const problems = [...collected.problems, ...applyAnnotations(graph, collected.annotations)];
  graph.build(META);
  return { graph, problems };
}

const UTIL = 'def help():\n    return 1\n';

function callEdge(graph: ConnectionGraph, from: string, to: string): Relationship | undefined {
  return graph
    .getRelationships()
    .find((rel) => rel.type === 'calls' && rel.from === from && rel.to === to);
}

describe('python source directives on a real run', () => {
  it('applies a directive above a call inside a function', () => {
    const { graph, problems } = run({
      'pkg/util.py': UTIL,
      'app.py': [
        'from pkg.util import help',
        '',
        'def run():',
        '    # balk2: confidence=low app.py:run calls pkg/util.py:help',
        '    return help()',
        '',
      ].join('\n'),
    });
    expect(problems).toEqual([]);
    expect(callEdge(graph, 'app.py:run', 'pkg/util.py:help')).toMatchObject({
      confidence: 'low',
      evidence: 'config',
      metadata: { annotated: true },
    });
  });

  it('applies a directive inside a method to the method, not the class', () => {
    const { graph, problems } = run({
      'pkg/util.py': UTIL,
      'app.py': [
        'from pkg.util import help',
        '',
        'class Service:',
        '    def run(self):',
        '        # balk2: confidence=low app.py:Service.run calls pkg/util.py:help',
        '        return help()',
        '',
      ].join('\n'),
    });
    expect(problems).toEqual([]);
    expect(callEdge(graph, 'app.py:Service.run', 'pkg/util.py:help')?.confidence).toBe('low');
  });

  it('rejects a directive whose source is not the enclosing function', () => {
    const { graph, problems } = run({
      'pkg/util.py': UTIL,
      'app.py': [
        'from pkg.util import help',
        '',
        'def run():',
        '    # balk2: confidence=low app.py:other calls pkg/util.py:help',
        '    return help()',
        '',
        'def other():',
        '    return 2',
        '',
      ].join('\n'),
    });
    expect(problems.map((p) => p.message)).toEqual([
      'source annotation from app.py:other does not match the enclosing owner app.py:run; annotation ignored',
    ]);
    expect(callEdge(graph, 'app.py:run', 'pkg/util.py:help')?.confidence).toBe('high');
  });

  it('lets a source directive override a config annotation for the same edge', () => {
    const config: Annotation[] = [
      { type: 'calls', from: 'app.py:run', to: 'pkg/util.py:help', confidence: 'medium' },
    ];
    const { graph, problems } = run(
      {
        'pkg/util.py': UTIL,
        'app.py': [
          'from pkg.util import help',
          '',
          'def run():',
          '    # balk2: confidence=low app.py:run calls pkg/util.py:help',
          '    return help()',
          '',
        ].join('\n'),
      },
      config,
    );
    expect(problems.map((p) => p.message)).toEqual([
      'calls from app.py:run to pkg/util.py:help is set in a source comment; the config annotation is ignored',
    ]);
    expect(callEdge(graph, 'app.py:run', 'pkg/util.py:help')?.confidence).toBe('low');
  });

  it('ignores a directive inside a docstring', () => {
    const { graph, problems } = run({
      'pkg/util.py': UTIL,
      'app.py': [
        'from pkg.util import help',
        '',
        'def run():',
        '    """',
        '    # balk2: confidence=low app.py:run calls pkg/util.py:help',
        '    """',
        '    return help()',
        '',
      ].join('\n'),
    });
    expect(problems).toEqual([]);
    expect(callEdge(graph, 'app.py:run', 'pkg/util.py:help')?.confidence).toBe('high');
  });
});
