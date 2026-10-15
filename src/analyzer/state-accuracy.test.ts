import { beforeAll, describe, expect, it, vi } from 'vitest';
import { STATE_CORPUS, type StateFixture } from '../testing/state-corpus.js';
import { analyzeStateFixture, statePairs, stateEdges } from '../testing/state-metrics.js';
import {
  difference,
  formatReport,
  observationsOf,
  score,
  sum,
  type ReportRow,
} from '../testing/event-metrics.js';

// The whole corpus is analyzed once, in a setup step; each fixture builds a TypeScript program.
vi.setConfig({ testTimeout: 30_000 });

interface Outcome {
  readonly pairs: string[];
  readonly edges: string[];
  readonly observations: string[];
}

const outcomes = new Map<string, Outcome>();
const outcomeOf = (fixture: StateFixture): Outcome => {
  const outcome = outcomes.get(fixture.name);
  if (!outcome) throw new Error(`Fixture not analyzed: ${fixture.name}`);
  return outcome;
};

const SUPPORTED = STATE_CORPUS.filter((fixture) => !fixture.limit);
const LIMITS = STATE_CORPUS.filter((fixture) => fixture.limit);

beforeAll(() => {
  for (const fixture of STATE_CORPUS) {
    const map = analyzeStateFixture(fixture);
    outcomes.set(fixture.name, {
      pairs: statePairs(map),
      edges: stateEdges(map),
      observations: observationsOf(map),
    });
  }
}, 180_000);

describe('state mapping accuracy: supported access patterns', () => {
  it.each(SUPPORTED.map((fixture) => [fixture.name, fixture] as const))(
    'connects exactly the right owners and state paths: %s',
    (_name, fixture) => {
      expect(outcomeOf(fixture).pairs).toEqual([...fixture.pairs].sort());
    },
  );

  it.each(SUPPORTED.map((fixture) => [fixture.name, fixture] as const))(
    'reports exactly the observations policy asks for: %s',
    (_name, fixture) => {
      expect(outcomeOf(fixture).observations).toEqual([...fixture.observations].sort());
    },
  );

  it.each(SUPPORTED.filter((f) => f.edges).map((fixture) => [fixture.name, fixture] as const))(
    'produces exactly the expected edges: %s',
    (_name, fixture) => {
      expect(outcomeOf(fixture).edges).toEqual([...(fixture.edges ?? [])].sort());
    },
  );
});

describe('state mapping accuracy: known limits', () => {
  it.each(LIMITS.map((fixture) => [fixture.name, fixture] as const))(
    'falls short in exactly the documented way: %s',
    (_name, fixture) => {
      const { pairs } = outcomeOf(fixture);
      const limit = fixture.limit;
      if (!limit) throw new Error('not a limit');

      expect(difference(fixture.pairs, pairs)).toEqual([...limit.missingPairs].sort());
      expect(difference(pairs, fixture.pairs)).toEqual([...limit.extraPairs].sort());
    },
  );

  it('documents a real shortfall for every limit, so none goes stale unnoticed', () => {
    for (const fixture of LIMITS) {
      const limit = fixture.limit;
      expect(limit && limit.missingPairs.length + limit.extraPairs.length).toBeGreaterThan(0);
    }
  });
});

describe('state mapping accuracy: overall', () => {
  const pairScores = (fixtures: readonly StateFixture[]): ReturnType<typeof sum> =>
    sum(fixtures.map((fixture) => score(fixture.pairs, outcomeOf(fixture).pairs)));

  it('is perfect on supported access patterns', () => {
    const supported = pairScores(SUPPORTED);
    expect(supported.expected).toBeGreaterThan(5);
    expect(supported.recall).toBe(1);
    expect(supported.precision).toBe(1);
  });

  it('produces no false positives beyond the ones documented as known limits', () => {
    const documented = LIMITS.reduce(
      (total, fixture) => total + (fixture.limit?.extraPairs.length ?? 0),
      0,
    );
    expect(pairScores(STATE_CORPUS).falsePositives).toBe(documented);
  });

  it('finds most of what a developer would connect, limits included', () => {
    expect(pairScores(STATE_CORPUS).recall).toBeGreaterThanOrEqual(0.7);
  });

  it('prints the report on request', () => {
    if (!process.env['BALK2_STATE_REPORT']) return;

    const rows: ReportRow[] = STATE_CORPUS.map((fixture) => {
      const outcome = outcomeOf(fixture);
      return {
        name: fixture.name,
        limit: fixture.limit !== undefined,
        pairs: score(fixture.pairs, outcome.pairs),
        observationsMatch:
          difference(fixture.observations, outcome.observations).length === 0 &&
          difference(outcome.observations, fixture.observations).length === 0,
        edgesExact: fixture.edges
          ? difference(fixture.edges, outcome.edges).length === 0 &&
            difference(outcome.edges, fixture.edges).length === 0
          : undefined,
      };
    });
    console.info(`\n${formatReport(rows)}\n`);
  });
});
