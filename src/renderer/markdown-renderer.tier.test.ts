import { describe, expect, it } from 'vitest';
import { ConnectionGraph } from '../graph.js';
import type { SourceSpan } from '../types.js';
import { renderMarkdown } from './markdown-renderer.js';

function spanAt(line: number): SourceSpan {
  return { filePath: 'src/a.ts', startLine: line, startColumn: 1, endLine: line, endColumn: 5 };
}

function mapWithTiers(): ReturnType<ConnectionGraph['build']> {
  const graph = new ConnectionGraph();
  graph.addUnresolved({
    reason: 'dynamic-registry-key',
    attempted: 'registers',
    subject: 'internalKey',
    location: spanAt(1),
    detail: 'dynamic',
    tier: 'internal',
  });
  graph.addUnresolved({
    reason: 'dynamic-registry-key',
    attempted: 'registers',
    subject: 'sharedKey',
    location: spanAt(2),
    detail: 'dynamic',
  });
  return graph.build({ generatedAt: 'test' });
}

describe('markdown output: observation tiers', () => {
  it('notes internal observations in the overview without counting them as actionable', () => {
    const markdown = renderMarkdown(mapWithTiers());
    expect(markdown).toContain(
      '- **Unresolved Observations**: 1 (1 internal, in connection-map.json)',
    );
  });

  it('lists actionable observations and omits internal ones from the section', () => {
    const markdown = renderMarkdown(mapWithTiers());
    expect(markdown).toContain('src/a.ts:2:1');
    expect(markdown).not.toContain('src/a.ts:1:1');
  });
});
