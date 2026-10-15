import { describe, expect, it } from 'vitest';
import { JsTsAnalyzer } from './js-ts-analyzer.js';
import { ConnectionGraph } from '../graph.js';
import { createRepositoryFixture } from '../testing/repository-fixture.js';
import type { ConnectionMap } from '../types.js';

const OPTIONS = { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' };
const META = { generatedAt: '2026-01-01T00:00:00Z' };
const CALLBACKS = [{ function: 'onReady', callbackArg: 0 }];

const lines = (...rows: string[]): string => rows.join('\n');

function analyze(files: Record<string, string>): ConnectionMap {
  const fixture = createRepositoryFixture(files, OPTIONS);
  try {
    const graph = new ConnectionGraph();
    new JsTsAnalyzer().analyzeRepository(fixture.repository, graph, { callbacks: CALLBACKS });
    return graph.build(META);
  } finally {
    fixture.cleanup();
  }
}

function unresolvedCallbacks(map: ConnectionMap): string[] {
  return Object.values(map.unresolved)
    .filter((node) => node.reason === 'unresolved-callback')
    .map((node) => node.subject)
    .sort();
}

describe('a configured callback that cannot be resolved is an observation', () => {
  it('a callback produced by a call is reported, linked from its caller at low confidence', () => {
    const map = analyze({
      'bus.ts': 'export function onReady(handler: () => void): void { handler(); }',
      'make.ts': 'export function makeHandler(): () => void { return () => {}; }',
      'app.ts': lines(
        "import { onReady } from './bus.js';",
        "import { makeHandler } from './make.js';",
        'export function setup(): void { onReady(makeHandler()); }',
      ),
    });

    expect(unresolvedCallbacks(map)).toEqual(['makeHandler()']);
    const observation = Object.values(map.unresolved).find(
      (node) => node.reason === 'unresolved-callback',
    );
    expect(map.relationships).toContainEqual(
      expect.objectContaining({
        type: 'passesCallback',
        from: 'app.ts:setup',
        to: observation?.id,
        confidence: 'low',
      }),
    );
  });

  it('a callback that is a parameter of the caller is reported', () => {
    const map = analyze({
      'bus.ts': 'export function onReady(handler: () => void): void { handler(); }',
      'app.ts': lines(
        "import { onReady } from './bus.js';",
        'export function setup(handler: () => void): void { onReady(handler); }',
      ),
    });

    expect(unresolvedCallbacks(map)).toEqual(['handler']);
  });

  it('a callback imported from an unresolved package is silent, as external modules are elsewhere', () => {
    const map = analyze({
      'bus.ts': 'export function onReady(handler: () => void): void { handler(); }',
      'app.ts': lines(
        "import { onReady } from './bus.js';",
        "import { ready } from 'some-missing-package';",
        'export function setup(): void { onReady(ready); }',
      ),
    });

    expect(unresolvedCallbacks(map)).toEqual([]);
  });
});
