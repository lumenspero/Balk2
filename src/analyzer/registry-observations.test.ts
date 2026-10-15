import { describe, expect, it } from 'vitest';
import { JsTsAnalyzer } from './js-ts-analyzer.js';
import { ConnectionGraph } from '../graph.js';
import { createRepositoryFixture } from '../testing/repository-fixture.js';

const OPTIONS = { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' };
const META = { generatedAt: '2026-01-01T00:00:00Z' };

const lines = (...rows: string[]): string => rows.join('\n');

/** Every unresolved observation as `reason | subject`, sorted. */
function observationsOf(files: Record<string, string>): string[] {
  const fixture = createRepositoryFixture(files, OPTIONS);
  try {
    const graph = new ConnectionGraph();
    new JsTsAnalyzer().analyzeRepository(fixture.repository, graph, {});
    return Object.values(graph.build(META).unresolved)
      .map((node) => `${node.reason} | ${node.subject}`)
      .sort();
  } finally {
    fixture.cleanup();
  }
}

describe('local collections are not registries', () => {
  it('a local Set filled from runtime values is silent, even beside a real registration', () => {
    expect(
      observationsOf({
        'user.ts': 'export class User {}',
        'app.ts': lines(
          "import { User } from './user.js';",
          'export const registry = new Map<string, unknown>();',
          "registry.set('user', User);",
          'export function scan(names: string[]): number {',
          '  const seen = new Set<string>();',
          '  for (const name of names) seen.add(name);',
          '  return seen.size;',
          '}',
        ),
      }),
    ).toEqual([]);
  });

  it('a local Map written with a runtime value and a computed key is silent', () => {
    expect(
      observationsOf({
        'build.ts': lines(
          'export function build(names: string[]): number {',
          '  const seen = new Map<string, object>();',
          '  for (const name of names) {',
          '    const item = { name };',
          '    seen.set(name, item);',
          '  }',
          '  return seen.size;',
          '}',
        ),
      }),
    ).toEqual([]);
  });

  it('a local Map read with a computed key is silent', () => {
    expect(
      observationsOf({
        'lookup.ts': lines(
          'export function index(entries: Array<[string, number]>): number {',
          '  const table = new Map<string, number>();',
          '  for (const [key, value] of entries) table.set(key, value);',
          '  return table.get(String(entries.length)) ?? 0;',
          '}',
        ),
      }),
    ).toEqual([]);
  });

  it('a dynamic registration of a repository class is still reported (control)', () => {
    expect(
      observationsOf({
        'user.ts': 'export class User {}',
        'dyn.ts': lines(
          "import { User } from './user.js';",
          'export const dynRegistry = new Map<string, unknown>();',
          'export function add(name: string): void { dynRegistry.set(name, User); }',
        ),
      }),
    ).toEqual(['dynamic-registry-key | dynRegistry.set(name, User)']);
  });
});
