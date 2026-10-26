import { describe, expect, it, vi } from 'vitest';
import { canonicalGraph } from '../testing/canonical-graph.js';
import { analyzeFiles, corpusEntries, type CorpusEntry } from '../testing/parity-metrics.js';

// Each rendition writes a repository and runs the full analysis, so keep the default 5s limit out of the way.
vi.setConfig({ testTimeout: 60_000 });

/**
 * The snapshot name of one rendition (V3 Phase 16.2). Parity scenarios exist once per language, so
 * their names carry the language. The python and rust corpora are already per language.
 */
export function snapshotName(entry: CorpusEntry): string {
  const slug = entry.scenario.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return entry.corpus === 'parity' ? `parity-${entry.language}-${slug}` : `${entry.corpus}-${slug}`;
}

const ENTRIES = corpusEntries();

/**
 * The whole canonical graph of every corpus rendition, one snapshot each. A change in any node or
 * relationship of any scenario shows up in its file, including changes that no expectation checks.
 * Snapshots are written locally and checked in; CI does not write new ones, so a missing file fails.
 */
describe('corpus canonical snapshots', () => {
  it('gives every rendition its own snapshot name', () => {
    const names = ENTRIES.map(snapshotName);
    expect(new Set(names).size, 'duplicate snapshot names').toBe(names.length);
  });

  it.each(ENTRIES.map((entry) => [snapshotName(entry), entry] as const))(
    'snapshots %s',
    async (name, entry) => {
      const { map } = analyzeFiles(entry.rendition.files, entry.rendition.config);
      await expect(canonicalGraph(map)).toMatchFileSnapshot(`../../test/snapshots/${name}.txt`);
    },
  );
});
