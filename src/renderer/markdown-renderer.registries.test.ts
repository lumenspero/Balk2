import { describe, expect, it } from 'vitest';
import { ConnectionGraph } from '../graph.js';
import type { ConnectionMap } from '../types.js';
import { renderMarkdown } from './markdown-renderer.js';

const METADATA = { generatedAt: '2026-01-01T00:00:00Z' };
const USER_KEY = 'registry:src/container.ts:container#user';

/** The lines of one `## ` section, up to the next one. */
function major(markdown: string, heading: string): string {
  const parts = markdown.split('\n## ');
  const found = parts.find((part) => part.startsWith(heading) || part.startsWith(`## ${heading}`));
  if (!found) throw new Error(`No section ${heading}`);
  return found;
}

/** The lines of one `### ` entry, up to the next heading. */
function entry(markdown: string, heading: string): string[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line === `### ${heading}`);
  if (start < 0) throw new Error(`No entry ${heading}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('#'));
  return (end < 0 ? rest : rest.slice(0, end)).filter((line) => line.length > 0);
}

function registryMap(): ConnectionMap {
  const graph = new ConnectionGraph();
  graph.addFile('src/app.ts', 'typescript');
  graph.addFile('src/user.ts', 'typescript');
  graph.addSymbol('src/user.ts', 'User', 'class');
  graph.addSymbol('src/app.ts', 'lookup', 'function');
  const user = graph.addRegistryKey('user', 'src/container.ts:container').id;
  const count = graph.addRegistryKey('404', 'src/cache.ts:store', 'number').id;
  graph.addRelationship('registers', user, 'src/user.ts:User', 'high');
  graph.addRelationship('resolves', 'src/app.ts:lookup', user);
  graph.addRelationship('registers', count, 'src/user.ts:User', 'high');
  return graph.build(METADATA);
}

describe('registries in the markdown output', () => {
  const map = registryMap();
  const markdown = renderMarkdown(map);

  it('counts registry keys in the overview', () => {
    expect(markdown).toContain('- **Registry Keys**: 2');
  });

  it('gives each key its own entry with its registration and its lookups', () => {
    expect(entry(markdown, USER_KEY)).toEqual([
      'Key: user',
      'Registry: src/container.ts:container',
      'Registered to:',
      '  → src/user.ts:User',
      'Looked up by:',
      '  ← src/app.ts:lookup',
    ]);
  });

  it('marks a numeric key as one', () => {
    const id = 'registry:src/cache.ts:store#number:404';
    expect(entry(markdown, id)).toContain('Key type: number');
  });

  it('shows what a lookup resolves, on the node that performs it', () => {
    const symbols = major(markdown, 'Symbol Connections');
    expect(symbols).toContain('### src/app.ts:lookup');
    expect(symbols).toContain(`Resolves:\n  → ${USER_KEY}`);
  });

  it('keeps registry keys out of the symbol list', () => {
    const symbols = major(markdown, 'Symbol Connections');
    expect(symbols).not.toContain(`### ${USER_KEY}`);
  });
});
