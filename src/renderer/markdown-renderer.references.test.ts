import { describe, expect, it } from 'vitest';
import { JsTsAnalyzer } from '../analyzer/js-ts-analyzer.js';
import { ConnectionGraph } from '../graph.js';
import type { ConnectionMap } from '../types.js';
import { renderMarkdown } from './markdown-renderer.js';

const METADATA = { generatedAt: '2026-01-01T00:00:00Z' };

/** The lines of one `### heading` section, up to the next heading. */
function section(markdown: string, heading: string): string[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`### ${heading}`));
  if (start < 0) throw new Error(`No section for ${heading}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('#'));
  return (end < 0 ? rest : rest.slice(0, end)).filter((line) => line.length > 0);
}

function analyzedMap(): ConnectionMap {
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
  return graph.build(METADATA);
}

describe('reverse relationships render from the correct side', () => {
  const markdown = renderMarkdown(analyzedMap());

  it('lists only real callers under "Called by"', () => {
    expect(section(markdown, 'src/state.ts:updateState')).toEqual([
      'Calls:',
      '  → src/sim.ts:stepSim',
      'Called by:',
      '  ← src/main.ts:main',
    ]);
    expect(section(markdown, 'src/sim.ts:stepSim')).toEqual([
      'Called by:',
      '  ← src/state.ts:updateState',
    ]);
  });

  it('lists only real importers under "Imported by"', () => {
    expect(section(markdown, 'src/state.ts')).toEqual([
      'Imports:',
      '  → src/sim.ts',
      'Imported by:',
      '  ← src/main.ts',
    ]);
    expect(section(markdown, 'src/sim.ts')).toEqual(['Imported by:', '  ← src/state.ts']);
  });
});

describe('references relationships', () => {
  const graph = new ConnectionGraph();
  graph.addFile('main.ts', 'typescript');
  graph.addFile('lib.ts', 'typescript');
  graph.addSymbol('main.ts', 'run', 'function');
  graph.addSymbol('lib.ts', 'boot', 'function');
  graph.addRelationship('references', 'main.ts:run', 'lib.ts:boot');
  graph.addRelationship('references', 'main.ts', 'lib.ts');
  graph.addRelationship('references', 'main.ts', 'lib.ts:boot');
  const markdown = renderMarkdown(graph.build(METADATA));

  it('shows file-level references in both directions', () => {
    expect(section(markdown, 'main.ts')).toEqual([
      '*(No direct file imports)*',
      'References:',
      '  → lib.ts',
      '  → lib.ts:boot',
    ]);
    expect(section(markdown, 'lib.ts')).toEqual([
      '*(No direct file imports)*',
      'Referenced by:',
      '  ← main.ts',
    ]);
  });

  it('shows symbol-level references in both directions', () => {
    expect(section(markdown, 'main.ts:run')).toEqual(['References:', '  → lib.ts:boot']);
    expect(section(markdown, 'lib.ts:boot')).toEqual([
      'Referenced by:',
      '  ← main.ts',
      '  ← main.ts:run',
    ]);
  });
});
