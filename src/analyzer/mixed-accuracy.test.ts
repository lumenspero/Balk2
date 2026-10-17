import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MIXED_CORPUS, type MixedFixture } from '../testing/mixed-corpus.js';
import {
  analyzeMixedFixture,
  connectionPairs,
  mixedEdges,
  registryPairs,
  statePairs,
} from '../testing/mixed-metrics.js';
import { observationsOf } from '../testing/event-metrics.js';

// Each fixture builds a TypeScript program; the default 5s limit is too tight on a busy machine.
vi.setConfig({ testTimeout: 30_000 });

interface Outcome {
  readonly events: string[];
  readonly registries: string[];
  readonly states: string[];
  readonly observations: string[];
  readonly edges: string[];
}

const outcomes = new Map<string, Outcome>();
const outcomeOf = (fixture: MixedFixture): Outcome => {
  const outcome = outcomes.get(fixture.name);
  if (!outcome) throw new Error(`Fixture not analyzed: ${fixture.name}`);
  return outcome;
};

beforeAll(() => {
  for (const fixture of MIXED_CORPUS) {
    const map = analyzeMixedFixture(fixture);
    outcomes.set(fixture.name, {
      events: connectionPairs(map),
      registries: registryPairs(map),
      states: statePairs(map),
      observations: observationsOf(map),
      edges: mixedEdges(map),
    });
  }
}, 180_000);

describe('mixed-mechanism accuracy', () => {
  it.each(MIXED_CORPUS.map((fixture) => [fixture.name, fixture] as const))(
    'connects exactly the right publishers and subscribers: %s',
    (_name, fixture) => {
      expect(outcomeOf(fixture).events).toEqual([...fixture.events].sort());
    },
  );

  it.each(MIXED_CORPUS.map((fixture) => [fixture.name, fixture] as const))(
    'connects exactly the right callers and registry targets: %s',
    (_name, fixture) => {
      expect(outcomeOf(fixture).registries).toEqual([...fixture.registries].sort());
    },
  );

  it.each(MIXED_CORPUS.map((fixture) => [fixture.name, fixture] as const))(
    'connects exactly the right owners and state paths: %s',
    (_name, fixture) => {
      expect(outcomeOf(fixture).states).toEqual([...fixture.states].sort());
    },
  );

  it.each(MIXED_CORPUS.map((fixture) => [fixture.name, fixture] as const))(
    'reports exactly the observations policy asks for: %s',
    (_name, fixture) => {
      expect(outcomeOf(fixture).observations).toEqual([...fixture.observations].sort());
    },
  );

  it.each(MIXED_CORPUS.map((fixture) => [fixture.name, fixture] as const))(
    'produces exactly the expected family edges: %s',
    (_name, fixture) => {
      expect(outcomeOf(fixture).edges).toEqual([...fixture.edges].sort());
    },
  );
});
