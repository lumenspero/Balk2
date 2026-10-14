import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConnectionGraph } from '../graph.js';
import { getIncoming } from '../graph-queries.js';
import { createRepositoryFixture, type RepositoryFixture } from '../testing/repository-fixture.js';
import { storedReverseTypes } from '../testing/legacy-maps.js';
import type { ConnectionMap } from '../types.js';
import { JsTsAnalyzer } from './js-ts-analyzer.js';

vi.setConfig({ testTimeout: 30_000 });

describe('the JS/TS analyzer stores each relationship once', () => {
  let fixture: RepositoryFixture | undefined;
  let map: ConnectionMap;

  beforeAll(() => {
    fixture = createRepositoryFixture({
      'util.ts': 'export function help(): number { return 1; }',
      'barrel.ts': "export { help } from './util.js';",
      'main.ts': [
        "import { help } from './util.js';",
        'export function run(): number { return help(); }',
      ].join('\n'),
      'other.ts': [
        "import { help } from './util.js';",
        'export function again(): number { return help(); }',
      ].join('\n'),
    });
    const graph = new ConnectionGraph();
    new JsTsAnalyzer().analyzeRepository(fixture.repository, graph);
    map = graph.build({ generatedAt: '2026-01-01T00:00:00Z' });
  });
  afterAll(() => fixture?.cleanup());

  it('stores no reverse link of any kind', () => {
    expect(storedReverseTypes(map)).toEqual([]);
  });

  it('still answers who imports a file and who calls a function', () => {
    expect(getIncoming(map, 'util.ts', 'imports').map((r) => r.from)).toEqual([
      'barrel.ts',
      'main.ts',
      'other.ts',
    ]);
    expect(getIncoming(map, 'util.ts:help', 'calls').map((r) => r.from)).toEqual([
      'main.ts:run',
      'other.ts:again',
    ]);
  });
});
