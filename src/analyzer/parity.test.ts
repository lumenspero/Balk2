import { afterAll, describe, expect, it, vi } from 'vitest';
import { CORPUS_LANGUAGES, parseRelationship } from '../testing/corpus-types.js';
import { PARITY_CORPUS } from '../testing/parity-corpus.js';
import { corpusEntries, evaluate } from '../testing/parity-metrics.js';

// Each case writes a repository and runs the full analysis, so keep the default 5s limit out of the way.
vi.setConfig({ testTimeout: 60_000 });

const ALL = corpusEntries();

describe('parity corpus', () => {
  it('every parity scenario covers every language, or names a semantic reason to skip one', () => {
    const problems: string[] = [];
    for (const scenario of PARITY_CORPUS) {
      for (const language of CORPUS_LANGUAGES) {
        const covered = Boolean(scenario.renditions[language]);
        const skipped = Boolean(scenario.notApplicable?.[language]);
        if (!covered && !skipped) {
          problems.push(`${scenario.name}: ${language} has neither a rendition nor a reason`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('every expectation string parses', () => {
    for (const entry of ALL) {
      for (const text of [
        ...(entry.rendition.expect.relationships ?? []),
        ...(entry.rendition.expect.absent ?? []),
      ]) {
        expect(
          () => parseRelationship(text),
          `${entry.corpus}/${entry.scenario.name}`,
        ).not.toThrow();
      }
    }
  });

  it.each(ALL.filter((e) => !e.rendition.pending))(
    '$corpus / $language: $scenario.name',
    (entry) => {
      expect(evaluate(entry).unmet).toEqual([]);
    },
  );

  it.each(ALL.filter((e) => e.rendition.pending))(
    'pending $corpus / $language: $scenario.name (phase $rendition.pending)',
    () => {
      // Pending renditions are targets. Each phase removes its own `pending` marker.
    },
  );
});

afterAll(() => {
  const counts = new Map<string, number>();
  for (const entry of ALL) {
    if (entry.rendition.pending) {
      counts.set(entry.language, (counts.get(entry.language) ?? 0) + 1);
    }
  }
  const total = ALL.length;
  const summary = CORPUS_LANGUAGES.map(
    (language) =>
      `${language}: ${counts.get(language) ?? 0} pending of ${ALL.filter((e) => e.language === language).length}`,
  ).join('; ');
  // The pending count is the progress measure reported in CI. It must reach zero per language
  // before that language's release gate.
  console.log(`Parity pending renditions (${total} total): ${summary}`);
});
