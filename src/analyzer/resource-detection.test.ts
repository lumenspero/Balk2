import { describe, expect, it } from 'vitest';
import { JsTsAnalyzer } from './js-ts-analyzer.js';
import { ConnectionGraph } from '../graph.js';
import { createRepositoryFixture } from '../testing/repository-fixture.js';
import type { ConnectionMap } from '../types.js';

const OPTIONS = { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' };
const META = { generatedAt: '2026-01-01T00:00:00Z' };
const lines = (...rows: string[]): string => rows.join('\n');

function analyze(files: Record<string, string>): ConnectionMap {
  const fixture = createRepositoryFixture(files, OPTIONS);
  try {
    const graph = new ConnectionGraph();
    new JsTsAnalyzer().analyzeRepository(fixture.repository, graph, {
      resources: [{ function: 'loadTemplate', specifierArg: 0 }],
    });
    return graph.build(META);
  } finally {
    fixture.cleanup();
  }
}

describe('static resource imports', () => {
  it('a stylesheet import links the importing file to a resource node', () => {
    const map = analyze({
      'app.css': 'body { margin: 0; }',
      'main.ts': "import './app.css';\nexport const x = 1;",
    });
    expect(map.resources['resource:app.css']).toMatchObject({
      kind: 'resource',
      path: 'app.css',
      resourceKind: 'stylesheet',
    });
    expect(map.relationships).toContainEqual(
      expect.objectContaining({
        type: 'usesResource',
        from: 'main.ts',
        to: 'resource:app.css',
        metadata: { resourceKind: 'stylesheet', mechanism: 'import' },
      }),
    );
  });

  it('a template imported with a ?raw query resolves to the template file', () => {
    const map = analyze({
      'page.html': '<h1>hi</h1>',
      'main.ts': "import tpl from './page.html?raw';\nexport const t = tpl;",
    });
    expect(map.resources['resource:page.html']).toMatchObject({ resourceKind: 'template' });
  });

  it('a resource file that is not in the repository is silent', () => {
    const map = analyze({
      'main.ts': "import './missing.css';\nexport const x = 1;",
    });
    expect(map.resources).toEqual({});
    expect(Object.keys(map.unresolved)).toEqual([]);
  });

  it('a schema file is a schema resource, not a data artifact', () => {
    const map = analyze({
      'user.schema.json': '{}',
      'main.ts': "import schema from './user.schema.json';\nexport const s = schema;",
    });
    expect(map.resources['resource:user.schema.json']).toMatchObject({ resourceKind: 'schema' });
    expect(map.artifacts['user.schema.json']).toBeUndefined();
  });

  it('a plain json file stays a data artifact and is not a resource', () => {
    const map = analyze({
      'config.json': '{}',
      'main.ts': "import data from './config.json';\nexport const d = data;",
    });
    expect(map.artifacts['config.json']).toMatchObject({ format: 'json' });
    expect(map.resources).toEqual({});
  });
});

describe('configured resource loaders', () => {
  it('a configured loader call links the owner to the resource it names', () => {
    const map = analyze({
      'tpl/card.html': '<div></div>',
      'render.ts': lines(
        'declare function loadTemplate(p: string): string;',
        "export function render(): string { return loadTemplate('tpl/card.html'); }",
      ),
    });
    expect(map.relationships).toContainEqual(
      expect.objectContaining({
        type: 'usesResource',
        from: 'render.ts:render',
        to: 'resource:tpl/card.html',
        metadata: { resourceKind: 'template', mechanism: 'loader' },
      }),
    );
  });

  it('a loader call with a computed path is an observation', () => {
    const map = analyze({
      'render.ts': lines(
        'declare function loadTemplate(p: string): string;',
        'export function render(name: string): string { return loadTemplate(name); }',
      ),
    });
    expect(Object.values(map.unresolved).map((node) => node.reason)).toEqual([
      'dynamic-resource-specifier',
    ]);
  });
});
