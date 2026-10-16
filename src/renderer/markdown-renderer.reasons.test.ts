import { describe, expect, it } from 'vitest';
import { ConnectionGraph } from '../graph.js';
import type { ConnectionMap, SourceSpan } from '../types.js';
import { renderMarkdown } from './markdown-renderer.js';

function spanAt(line: number): SourceSpan {
  return { filePath: 'src/a.ts', startLine: line, startColumn: 1, endLine: line, endColumn: 5 };
}

function mapWithReasons(): ConnectionMap {
  const graph = new ConnectionGraph();
  graph.addUnresolved({
    reason: 'dynamic-registry-key',
    attempted: 'registers',
    subject: 'a',
    location: spanAt(1),
  });
  graph.addUnresolved({
    reason: 'dynamic-registry-key',
    attempted: 'registers',
    subject: 'b',
    location: spanAt(2),
  });
  graph.addUnresolved({
    reason: 'ambiguous-global',
    attempted: 'references',
    subject: 'c',
    location: spanAt(3),
  });
  return graph.build({ generatedAt: 'test' });
}

describe('markdown overview: observations by reason', () => {
  it('lists actionable counts per reason in a fixed order', () => {
    const markdown = renderMarkdown(mapWithReasons());
    expect(markdown).toContain(
      [
        '- **Unresolved Observations**: 3',
        '  - ambiguous-global: 1',
        '  - dynamic-registry-key: 2',
      ].join('\n'),
    );
  });
});
