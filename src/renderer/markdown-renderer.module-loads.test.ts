import { describe, expect, it } from 'vitest';
import { ConnectionGraph } from '../graph.js';
import { JsTsAnalyzer } from '../analyzer/js-ts-analyzer.js';
import { createRepositoryFixture, type RepositoryFixture } from '../testing/repository-fixture.js';
import { renderMarkdown } from './markdown-renderer.js';

const META = { generatedAt: '2026-01-01T00:00:00Z' };
const OPTIONS = { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' };

function render(files: Record<string, string>): string {
  const fixture: RepositoryFixture = createRepositoryFixture(files, OPTIONS);
  try {
    const graph = new ConnectionGraph();
    new JsTsAnalyzer().analyzeRepository(fixture.repository, graph);
    return renderMarkdown(graph.build(META));
  } finally {
    fixture.cleanup();
  }
}

describe('renderMarkdown: dynamic module loads', () => {
  const dynamic = render({
    'util.ts': 'export const help = 1;',
    'main.ts': "export function lazy() { return import('./util.js'); }",
  });

  it("shows the load kind on the owning symbol's import", () => {
    expect(dynamic).toContain('### main.ts:lazy');
    expect(dynamic).toContain('Imports:\n  → util.ts (import-expression)');
  });

  it("shows the importing symbol under the file's imported-by list, with its load kind", () => {
    expect(dynamic).toContain('  ← main.ts:lazy (import-expression)');
  });

  it('leaves a static import without a suffix', () => {
    const text = render({
      'util.ts': 'export const help = 1;',
      'main.ts': "import { help } from './util.js'; export const k = help;",
    });
    expect(text).toContain('  → util.ts\n');
    expect(text).not.toContain('(import-expression)');
  });
});
