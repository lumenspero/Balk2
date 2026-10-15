import { describe, expect, it } from 'vitest';
import { ConnectionGraph } from '../graph.js';
import type { ConnectionMap } from '../types.js';
import { renderMarkdown } from './markdown-renderer.js';

const METADATA = { generatedAt: '2026-01-01T00:00:00Z' };
const USER = 'state:src/store.ts:store#user';

/** The text of one `## ` section, or `undefined` when the document has no such section. */
function sectionOf(markdown: string, heading: string): string | undefined {
  return markdown.split('\n## ').find((part) => part.split('\n')[0] === heading);
}

/** `save` writes the user state through `set`; `load` reads it, with medium confidence. */
function couplingMap(): ConnectionMap {
  const graph = new ConnectionGraph();
  graph.addFile('src/a.ts', 'typescript');
  graph.addFile('src/b.ts', 'typescript');
  const save = graph.addSymbol('src/a.ts', 'save', 'function').id;
  const load = graph.addSymbol('src/b.ts', 'load', 'function').id;
  const user = graph.addStatePath('src/store.ts:store', 'singleton', ['user']).id;
  graph.addRelationship('writesState', save, user, 'high', {
    evidence: 'config',
    metadata: { operation: 'call', method: 'set' },
  });
  graph.addRelationship('readsState', load, user, 'medium', {
    evidence: 'config',
    metadata: { operation: 'read' },
  });
  return graph.build(METADATA);
}

describe('Phase 6.7: shared state coupling section', () => {
  it('lists who writes and who reads a coupled path, with method and confidence', () => {
    const markdown = renderMarkdown(couplingMap());
    const coupling = sectionOf(markdown, 'Shared State Coupling');

    expect(markdown).toContain('- **State Paths**: 1');
    expect(coupling).toBeDefined();
    expect(coupling).toContain(`### ${USER}`);
    expect(coupling).toContain('Root: src/store.ts:store');
    expect(coupling).toContain('Written by:\n  ← src/a.ts:save via set');
    expect(coupling).toContain('Read by:\n  ← src/b.ts:load (medium confidence)');
  });

  it('is omitted when no path couples owners', () => {
    const graph = new ConnectionGraph();
    graph.addFile('src/b.ts', 'typescript');
    const load = graph.addSymbol('src/b.ts', 'load', 'function').id;
    const user = graph.addStatePath('src/store.ts:store', 'singleton', ['user']).id;
    graph.addRelationship('readsState', load, user, 'high', { evidence: 'config' });

    const markdown = renderMarkdown(graph.build(METADATA));
    expect(sectionOf(markdown, 'Shared State Coupling')).toBeUndefined();
  });

  it('keeps state edges out of file and symbol connections', () => {
    const markdown = renderMarkdown(couplingMap());

    expect(sectionOf(markdown, 'File Connections')).toBeDefined();
    expect(sectionOf(markdown, 'File Connections')).not.toContain('state:');
    expect(sectionOf(markdown, 'Symbol Connections')).toBeDefined();
    expect(sectionOf(markdown, 'Symbol Connections')).not.toContain('state:');
  });
});
