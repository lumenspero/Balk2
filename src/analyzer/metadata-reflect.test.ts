import { describe, expect, it } from 'vitest';
import { JsTsAnalyzer } from './js-ts-analyzer.js';
import { ConnectionGraph } from '../graph.js';
import { createRepositoryFixture } from '../testing/repository-fixture.js';
import type { MetadataProtocol } from './metadata-protocols.js';
import type { ConnectionMap } from '../types.js';

const OPTIONS = { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' };
const META = { generatedAt: '2026-01-01T00:00:00Z' };
const lines = (...rows: string[]): string => rows.join('\n');

const METADATA: MetadataProtocol[] = [{ key: 'route', defines: true, reads: true }];

function analyze(files: Record<string, string>): ConnectionMap {
  const fixture = createRepositoryFixture(files, OPTIONS);
  try {
    const graph = new ConnectionGraph();
    new JsTsAnalyzer().analyzeRepository(fixture.repository, graph, { metadata: METADATA });
    return graph.build(META);
  } finally {
    fixture.cleanup();
  }
}

describe('Reflect metadata with a configured key', () => {
  const files = {
    'decorate.ts': 'export function Route(path: string) { return (t: unknown): void => {}; }',
    'users.ts': lines(
      'export class UsersController {}',
      'declare const Reflect: { defineMetadata(k: string, v: unknown, t: unknown): void; getMetadata(k: string, t: unknown): unknown };',
      "Reflect.defineMetadata('route', '/users', UsersController);",
    ),
    'router.ts': lines(
      "import { UsersController } from './users.js';",
      'declare const Reflect: { getMetadata(k: string, t: unknown): unknown };',
      'export function mount(): unknown { return Reflect.getMetadata("route", UsersController); }',
    ),
  };

  it('a define of a configured key links the top-level target to the metadata key', () => {
    const map = analyze(files);
    expect(map.relationships).toContainEqual(
      expect.objectContaining({
        type: 'definesMetadata',
        from: 'users.ts:UsersController',
        to: 'metadata:route',
      }),
    );
  });

  it('a read of the same key links the enclosing owner to the metadata key', () => {
    const map = analyze(files);
    expect(map.relationships).toContainEqual(
      expect.objectContaining({
        type: 'readsMetadata',
        from: 'router.ts:mount',
        to: 'metadata:route',
      }),
    );
  });

  it('creates one metadata-key node per configured key that is used', () => {
    const map = analyze(files);
    expect(Object.keys(map.metadataKeys)).toEqual(['metadata:route']);
  });

  it('ignores Reflect calls whose key is not configured', () => {
    const map = analyze({
      'users.ts': lines(
        'export class UsersController {}',
        'declare const Reflect: { defineMetadata(k: string, v: unknown, t: unknown): void };',
        "Reflect.defineMetadata('other', 1, UsersController);",
      ),
    });
    expect(map.metadataKeys).toEqual({});
    expect(
      map.relationships.filter(
        (rel) => rel.type === 'definesMetadata' && rel.to.startsWith('metadata:'),
      ),
    ).toEqual([]);
  });

  it('reports a non-constant metadata key as an unresolved-metadata-key observation', () => {
    const map = analyze({
      'users.ts': lines(
        'export class UsersController {}',
        'declare const Reflect: { getMetadata(k: string, t: unknown): unknown };',
        'export function read(k: string): unknown { return Reflect.getMetadata(k, UsersController); }',
      ),
    });
    const reasons = Object.values(map.unresolved).map((node) => node.reason);
    expect(reasons).toEqual(['unresolved-metadata-key']);
  });

  it('reports a target that is a local value as an unresolved-metadata-key observation', () => {
    const map = analyze({
      'users.ts': lines(
        'declare const Reflect: { defineMetadata(k: string, v: unknown, t: unknown): void };',
        'export function make(): void {',
        '  const local = { id: 1 };',
        "  Reflect.defineMetadata('route', '/x', local);",
        '}',
      ),
    });
    expect(Object.values(map.unresolved).map((node) => node.reason)).toEqual([
      'unresolved-metadata-key',
    ]);
    expect(
      map.relationships.filter(
        (rel) => rel.type === 'definesMetadata' && rel.to.startsWith('metadata:'),
      ),
    ).toEqual([]);
  });
});
