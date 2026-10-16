import { describe, expect, it } from 'vitest';
import { JsTsAnalyzer } from './js-ts-analyzer.js';
import { collectSourceAnnotations } from './source-annotations-apply.js';
import { ConnectionGraph } from '../graph.js';
import { createRepositoryFixture } from '../testing/repository-fixture.js';
import type { Annotation } from './annotations.js';
import { applyAnnotations } from './annotations.js';
import type { Relationship } from '../types.js';

const OPTIONS = { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' };

const lines = (...rows: string[]): string => rows.join('\n');

interface RunResult {
  readonly graph: ConnectionGraph;
  readonly problems: Array<{ path: string; message: string }>;
}

/** Analyze a fixture, then collect source directives and apply them, as build-graph does. */
function run(files: Record<string, string>, config: readonly Annotation[] = []): RunResult {
  const fixture = createRepositoryFixture(files, OPTIONS);
  try {
    const graph = new ConnectionGraph();
    new JsTsAnalyzer().analyzeRepository(fixture.repository, graph, {});
    const collected = collectSourceAnnotations(fixture.repository, config);
    const problems = [...collected.problems, ...applyAnnotations(graph, collected.annotations)];
    return { graph, problems };
  } finally {
    fixture.cleanup();
  }
}

const UTIL = 'export function help(): number { return 1; }';

function edgeOf(graph: ConnectionGraph, from: string, to: string): Relationship | undefined {
  return graph
    .getRelationships()
    .find((rel) => rel.type === 'calls' && rel.from === from && rel.to === to);
}

describe('source directives on a real file', () => {
  it('applies a directive above a call inside a function', () => {
    const { graph, problems } = run({
      'util.ts': UTIL,
      'main.ts': lines(
        "import { help } from './util.js';",
        'export function run(): number {',
        '  // balk2: confidence=low main.ts:run calls util.ts:help',
        '  return help();',
        '}',
      ),
    });
    expect(problems).toEqual([]);
    expect(edgeOf(graph, 'main.ts:run', 'util.ts:help')).toMatchObject({
      confidence: 'low',
      evidence: 'config',
      metadata: { annotated: true },
    });
  });

  it('applies a directive at top level with the file as owner', () => {
    const { graph, problems } = run({
      'util.ts': UTIL,
      'main.ts': lines(
        "import { help } from './util.js';",
        '// balk2: confidence=medium main.ts calls util.ts:help',
        'export const value = help();',
      ),
    });
    expect(problems).toEqual([]);
    expect(edgeOf(graph, 'main.ts', 'util.ts:help')).toMatchObject({ confidence: 'medium' });
  });
});

describe('ownership of a directive', () => {
  it('rejects a directive whose source is not the enclosing function', () => {
    const { graph, problems } = run({
      'util.ts': UTIL,
      'main.ts': lines(
        "import { help } from './util.js';",
        'export function run(): number {',
        '  // balk2: confidence=low main.ts:other calls util.ts:help',
        '  return help();',
        '}',
        'export function other(): number { return 2; }',
      ),
    });
    expect(problems.map((p) => p.message)).toEqual([
      'source annotation from main.ts:other does not match the enclosing owner main.ts:run; annotation ignored',
    ]);
    expect(edgeOf(graph, 'main.ts:run', 'util.ts:help')?.confidence).toBe('high');
  });

  it('attributes a directive inside a class method to the method, not the class', () => {
    const { graph, problems } = run({
      'util.ts': UTIL,
      'main.ts': lines(
        "import { help } from './util.js';",
        'export class Service {',
        '  run(): number {',
        '    // balk2: confidence=low main.ts:Service.run calls util.ts:help',
        '    return help();',
        '  }',
        '}',
      ),
    });
    expect(problems).toEqual([]);
    expect(edgeOf(graph, 'main.ts:Service.run', 'util.ts:help')?.confidence).toBe('low');
  });

  it('attributes a directive inside a nested block to the enclosing function', () => {
    const { graph, problems } = run({
      'util.ts': UTIL,
      'main.ts': lines(
        "import { help } from './util.js';",
        'export function run(flag: boolean): number {',
        '  if (flag) {',
        '    // balk2: confidence=low main.ts:run calls util.ts:help',
        '    return help();',
        '  }',
        '  return 0;',
        '}',
      ),
    });
    expect(problems).toEqual([]);
    expect(edgeOf(graph, 'main.ts:run', 'util.ts:help')?.confidence).toBe('low');
  });
});

describe('precedence between source and config', () => {
  it('lets a source directive override a config annotation for the same edge', () => {
    const config: Annotation[] = [
      { type: 'calls', from: 'main.ts:run', to: 'util.ts:help', confidence: 'medium' },
    ];
    const { graph, problems } = run(
      {
        'util.ts': UTIL,
        'main.ts': lines(
          "import { help } from './util.js';",
          'export function run(): number {',
          '  // balk2: confidence=low main.ts:run calls util.ts:help',
          '  return help();',
          '}',
        ),
      },
      config,
    );
    expect(problems.map((p) => p.message)).toEqual([
      'calls from main.ts:run to util.ts:help is set in a source comment; the config annotation is ignored',
    ]);
    expect(edgeOf(graph, 'main.ts:run', 'util.ts:help')?.confidence).toBe('low');
  });

  it('applies a config annotation when no source directive names the edge', () => {
    const config: Annotation[] = [
      { type: 'calls', from: 'main.ts:run', to: 'util.ts:help', confidence: 'medium' },
    ];
    const { graph, problems } = run(
      {
        'util.ts': UTIL,
        'main.ts': lines(
          "import { help } from './util.js';",
          'export function run(): number { return help(); }',
        ),
      },
      config,
    );
    expect(problems).toEqual([]);
    expect(edgeOf(graph, 'main.ts:run', 'util.ts:help')?.confidence).toBe('medium');
  });
});
