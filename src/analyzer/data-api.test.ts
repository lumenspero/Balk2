import * as ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionGraph } from '../graph.js';
import { createRepositoryFixture, type RepositoryFixture } from '../testing/repository-fixture.js';
import type { ConnectionMap } from '../types.js';
import { JsTsAnalyzer } from './js-ts-analyzer.js';
import { dataApiOfLiteral } from './data-api.js';

// Each group builds a TypeScript program; the default 5s limit is tight on a busy machine.
vi.setConfig({ testTimeout: 30_000 });

const META = { generatedAt: '2026-01-01T00:00:00Z' };
const DATA_TYPES = new Set(['generates', 'consumes', 'reads']);

/** Every data edge as `type from -> to`, sorted. */
function dataEdges(map: ConnectionMap): string[] {
  return map.relationships
    .filter((r) => DATA_TYPES.has(r.type))
    .map((r) => `${r.type} ${r.from} -> ${r.to}`)
    .sort();
}

function withFixture<T>(files: Record<string, string>, run: (f: RepositoryFixture) => T): T {
  const fixture = createRepositoryFixture(files);
  try {
    return run(fixture);
  } finally {
    fixture.cleanup();
  }
}

function build(fixture: RepositoryFixture): ConnectionMap {
  const graph = new ConnectionGraph();
  new JsTsAnalyzer().analyzeRepository(fixture.repository, graph, {});
  return graph.build(META);
}

/** Every string literal in a file whose text contains `.json`, in source order. */
function jsonLiterals(sourceFile: ts.SourceFile): ts.StringLiteral[] {
  const found: ts.StringLiteral[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) && node.text.includes('.json')) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

describe('data catalog: resolved fs calls (Phase 11.1)', () => {
  it('a namespace import of fs generates an artifact written with writeFileSync', () => {
    withFixture(
      {
        'a.ts': [
          "import * as fs from 'node:fs';",
          "export function save(): void { fs.writeFileSync('out/report.json', '{}'); }",
        ].join('\n'),
      },
      (fixture) => {
        expect(dataEdges(build(fixture))).toEqual(['generates a.ts -> out/report.json']);
      },
    );
  });

  it('a named import of appendFileSync generates, where the keyword rule would read', () => {
    // The text has no write keyword, so the keyword fallback gives a low-confidence read. The
    // catalog knows appendFileSync writes, and the edge is high-confidence generates.
    withFixture(
      {
        'a.ts': [
          "import { appendFileSync } from 'fs';",
          "export function log(): void { appendFileSync('logs/run.json', ''); }",
        ].join('\n'),
      },
      (fixture) => {
        const map = build(fixture);
        const edge = map.relationships.find((r) => r.to === 'logs/run.json');
        expect(edge?.type).toBe('generates');
        expect(edge?.confidence).toBe('high');
      },
    );
  });

  it('a read whose name contains write follows the catalog, not the keyword', () => {
    withFixture(
      {
        'a.ts': [
          "import { readFile } from 'fs/promises';",
          "export async function load(): Promise<unknown> { return readFile('write-cache.json'); }",
        ].join('\n'),
      },
      (fixture) => {
        const map = build(fixture);
        const edge = map.relationships.find((r) => r.to === 'write-cache.json');
        expect(edge?.type).toBe('consumes');
        expect(edge?.confidence).toBe('high');
      },
    );
  });

  it('fs.promises.readFile on a namespace import is a fs/promises read', () => {
    withFixture(
      {
        'a.ts': [
          "import * as fs from 'fs';",
          "export async function load(): Promise<unknown> { return fs.promises.readFile('in.json'); }",
        ].join('\n'),
      },
      (fixture) => {
        expect(dataEdges(build(fixture))).toEqual(['consumes a.ts -> in.json']);
      },
    );
  });

  it('a default import of fs and a stream constructor both resolve', () => {
    withFixture(
      {
        'a.ts': [
          "import fs from 'fs';",
          "export function open(): void { fs.createWriteStream('stream-out.json'); }",
        ].join('\n'),
      },
      (fixture) => {
        expect(dataEdges(build(fixture))).toEqual(['generates a.ts -> stream-out.json']);
      },
    );
  });

  it('a path built with path.join is still matched through the join', () => {
    withFixture(
      {
        'a.ts': [
          "import * as fs from 'fs';",
          "import * as path from 'path';",
          "export function load(dir: string): string { return fs.readFileSync(path.join(dir, 'data.json'), 'utf8'); }",
        ].join('\n'),
      },
      (fixture) => {
        const map = build(fixture);
        const edge = map.relationships.find((r) => r.type === 'consumes');
        expect(edge?.from).toBe('a.ts');
        expect(edge?.confidence).toBe('high');
      },
    );
  });
});

describe('data catalog: negatives (Phase 11.1)', () => {
  function apiOfEach(files: Record<string, string>): (boolean | undefined)[] {
    return withFixture(files, (fixture) => {
      const sourceFile = fixture.repository.sourceFiles.get('a.ts');
      if (!sourceFile) throw new Error('a.ts missing');
      return jsonLiterals(sourceFile).map(
        (literal) =>
          dataApiOfLiteral(literal, fixture.repository.checker, 'typescript') !== undefined,
      );
    });
  }

  it('a local object with a writeFileSync method is not the fs API', () => {
    expect(
      apiOfEach({
        'a.ts': [
          'const fs = { writeFileSync(p: string, d: string): void {} };',
          "export function save(): void { fs.writeFileSync('x.json', ''); }",
        ].join('\n'),
      }),
    ).toEqual([false]);
  });

  it('a write with no import of fs is not matched', () => {
    expect(
      apiOfEach({
        'a.ts': "export function save(): void { fs.writeFileSync('x.json', ''); }",
      }),
    ).toEqual([false]);
  });

  it('an export of fs outside the catalog is not matched', () => {
    expect(
      apiOfEach({
        'a.ts': [
          "import * as fs from 'fs';",
          "export function copy(): void { fs.copyFileSync('a.json', 'b.json'); }",
        ].join('\n'),
      }),
    ).toEqual([false, false]);
  });

  it('a module outside the catalog with the same export name is not matched', () => {
    expect(
      apiOfEach({
        'a.ts': [
          "import { writeFileSync } from 'my-lib';",
          "export function save(): void { writeFileSync('x.json', ''); }",
        ].join('\n'),
      }),
    ).toEqual([false]);
  });
});

describe('bare data path placement (Phase 11.4)', () => {
  const LOADER = {
    'src/app/load.ts': [
      "import * as fs from 'fs';",
      "export function load(): string { return fs.readFileSync('data.json', 'utf8'); }",
    ].join('\n'),
  };

  function artifactOf(files: Record<string, string>, dataPaths?: string[]): string[] {
    return withFixture(files, (fixture) => {
      const graph = new ConnectionGraph();
      const options = dataPaths ? { dataPaths: new Set(dataPaths) } : {};
      new JsTsAnalyzer().analyzeRepository(fixture.repository, graph, options);
      return dataEdges(graph.build(META));
    });
  }

  it('keeps the path as written when the caller gives no scanned paths', () => {
    expect(artifactOf(LOADER)).toEqual(['consumes src/app/load.ts -> data.json']);
  });

  it('places the path at the root when only the root file exists', () => {
    expect(artifactOf(LOADER, ['src/app/load.ts', 'data.json'])).toEqual([
      'consumes src/app/load.ts -> data.json',
    ]);
  });

  it('places the path next to the file when only that file exists', () => {
    expect(artifactOf(LOADER, ['src/app/load.ts', 'src/app/data.json'])).toEqual([
      'consumes src/app/load.ts -> src/app/data.json',
    ]);
  });

  it('places the path next to the file when neither candidate exists', () => {
    expect(artifactOf(LOADER, ['src/app/load.ts'])).toEqual([
      'consumes src/app/load.ts -> src/app/data.json',
    ]);
  });
});
