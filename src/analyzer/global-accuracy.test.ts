import { beforeAll, describe, expect, it, vi } from 'vitest';
import { GLOBAL_CORPUS, type GlobalFixture } from '../testing/global-corpus.js';
import { analyzeGlobalFixture, globalEdges, globalPairs } from '../testing/global-metrics.js';
import { observationsOf, score, sum } from '../testing/event-metrics.js';

// The whole corpus is analyzed once, in a setup step; each fixture builds a TypeScript program.
vi.setConfig({ testTimeout: 30_000 });

interface Outcome {
  readonly pairs: string[];
  readonly edges: string[];
  readonly observations: string[];
}

const outcomes = new Map<string, Outcome>();
const outcomeOf = (fixture: GlobalFixture): Outcome => {
  const outcome = outcomes.get(fixture.name);
  if (!outcome) throw new Error(`Fixture not analyzed: ${fixture.name}`);
  return outcome;
};

beforeAll(() => {
  for (const fixture of GLOBAL_CORPUS) {
    const map = analyzeGlobalFixture(fixture);
    outcomes.set(fixture.name, {
      pairs: globalPairs(map),
      edges: globalEdges(map),
      observations: observationsOf(map),
    });
  }
}, 180_000);

describe('global mapping accuracy: supported conventions', () => {
  it.each(GLOBAL_CORPUS.map((fixture) => [fixture.name, fixture] as const))(
    'connects exactly the right callers and globals: %s',
    (_name, fixture) => {
      expect(outcomeOf(fixture).pairs).toEqual([...fixture.pairs].sort());
    },
  );

  it.each(GLOBAL_CORPUS.map((fixture) => [fixture.name, fixture] as const))(
    'reports exactly the observations policy asks for: %s',
    (_name, fixture) => {
      expect(outcomeOf(fixture).observations).toEqual([...fixture.observations].sort());
    },
  );

  it.each(GLOBAL_CORPUS.map((fixture) => [fixture.name, fixture] as const))(
    'produces exactly the expected edges: %s',
    (_name, fixture) => {
      expect(outcomeOf(fixture).edges).toEqual([...fixture.edges].sort());
    },
  );
});

describe('global mapping accuracy: overall', () => {
  it('is perfect on the corpus', () => {
    const total = sum(
      GLOBAL_CORPUS.map((fixture) => score(fixture.pairs, outcomeOf(fixture).pairs)),
    );
    expect(total.expected).toBeGreaterThan(5);
    expect(total.recall).toBe(1);
    expect(total.precision).toBe(1);
  });
});
