import { describe, expect, it } from 'vitest';
import { JsTsAnalyzer } from './js-ts-analyzer.js';
import { ConnectionGraph } from '../graph.js';
import { createRepositoryFixture } from '../testing/repository-fixture.js';
import type { Relationship } from '../types.js';

const OPTIONS = { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' };

const lines = (...rows: string[]): string => rows.join('\n');

function registrationsOf(files: Record<string, string>): Relationship[] {
  const fixture = createRepositoryFixture(files, OPTIONS);
  try {
    const graph = new ConnectionGraph();
    new JsTsAnalyzer().analyzeRepository(fixture.repository, graph, {});
    return graph.getRelationships().filter((rel) => rel.type === 'registers');
  } finally {
    fixture.cleanup();
  }
}

describe('a local value is not a registration target', () => {
  it('a local object stored in a registry does not register the enclosing function', () => {
    expect(
      registrationsOf({
        'store.ts': lines(
          'export const registry = new Map<string, unknown>();',
          'export function fill(): void {',
          '  const local = { id: 1 };',
          "  registry.set('item', local);",
          '}',
        ),
      }),
    ).toEqual([]);
  });

  it('a local function stored in a registry does not register the enclosing function', () => {
    expect(
      registrationsOf({
        'store.ts': lines(
          'export const registry = new Map<string, unknown>();',
          'export function fill(): void {',
          '  const handler = (): void => {};',
          "  registry.set('handler', handler);",
          '}',
        ),
      }),
    ).toEqual([]);
  });
});
