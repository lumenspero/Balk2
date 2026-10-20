import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { buildConnectionGraphDetailed } from '../cli/build-graph.js';
import { canonicalGraph } from '../testing/canonical-graph.js';
import { serializeConnectionMap } from '../serialize.js';

// Phase 0.8 baseline. Captures what the current Python analyzer emits for a representative
// repository. Phase 5 must keep every edge here or record it as a false positive in
// docs/v3/python-changes.md.
vi.setConfig({ testTimeout: 30_000 });

const FIXTURE = path.resolve(__dirname, '../../test/fixtures/python-baseline');

describe('python baseline', () => {
  it('keeps the whole canonical graph stable for the baseline repository', async () => {
    const { graph, problems, syntaxErrors } = buildConnectionGraphDetailed(FIXTURE);
    const map = graph.build({ generatedAt: '2026-01-01T00:00:00Z' });
    const text =
      canonicalGraph(map) +
      `# problems\n${problems
        .map((p) => `${p.path}: ${p.message}`)
        .sort()
        .join('\n')}\n` +
      `# syntax\n${syntaxErrors
        .map((e) => `${e.path}:${e.line}:${e.column}`)
        .sort()
        .join('\n')}\n`;
    await expect(text).toMatchFileSnapshot('../../test/snapshots/python-baseline.txt');
    expect(serializeConnectionMap(map).length).toBeGreaterThan(0);
  });
});
