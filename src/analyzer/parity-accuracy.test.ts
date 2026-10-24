import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CORPUS_LANGUAGES, type CorpusLanguage } from '../testing/corpus-types.js';
import { formatAccuracyReport, measureAll, type Measure } from '../testing/parity-metrics.js';

// Each rendition writes a repository and runs the full analysis.
vi.setConfig({ testTimeout: 60_000 });

let measures: Measure[] = [];

beforeAll(() => {
  measures = measureAll();
}, 900_000);

/** Budgets from the V3 plan (0.7): the same for every language. Pending renditions are excluded. */
function budgetOf(language: CorpusLanguage): { recall: number; falsePositives: number } {
  const active = measures.filter((m) => m.language === language && !m.pending);
  const positives = active.reduce((sum, m) => sum + m.positives, 0);
  const met = active.reduce((sum, m) => sum + m.met, 0);
  const falsePositives = active.reduce((sum, m) => sum + m.falsePositives, 0);
  return { recall: positives === 0 ? 0 : met / positives, falsePositives };
}

describe('parity accuracy report', () => {
  it('prints per-language, per-family metrics for every parity-style rendition', () => {
    console.log(`\n${formatAccuracyReport(measures)}\n`);
  });

  it.each(CORPUS_LANGUAGES)('%s meets the recall and false-positive budgets', (language) => {
    const budget = budgetOf(language);
    expect({ language, ...budget }).toEqual({ language, recall: 1, falsePositives: 0 });
  });
});
