import { JsTsAnalyzer } from '../analyzer/js-ts-analyzer.js';
import { ConnectionGraph } from '../graph.js';
import { getIncoming } from '../graph-queries.js';
import type { ConnectionMap } from '../types.js';
import type { EventFixture } from './event-corpus.js';
import { createRepositoryFixture } from './repository-fixture.js';

const EVENT_TYPES = new Set(['emits', 'dispatches', 'subscribes', 'unsubscribes']);

/** Run the event pass over a fixture and return the resulting map. */
export function analyzeFixture(fixture: EventFixture): ConnectionMap {
  const repository = createRepositoryFixture(fixture.files);
  try {
    const graph = new ConnectionGraph();
    new JsTsAnalyzer().analyzeRepository(repository.repository, graph, {
      ...(fixture.options ? { events: fixture.options } : {}),
    });
    return graph.build({ generatedAt: '2026-01-01T00:00:00Z' });
  } finally {
    repository.cleanup();
  }
}

/**
 * Every publisher to subscriber pair that shares a channel, as `publisher -> subscriber`,
 * sorted and distinct. This is what "navigable through the shared channel" means, and it does
 * not depend on how channels are named.
 */
export function connectionPairs(map: ConnectionMap): string[] {
  const pairs = new Set<string>();
  for (const channel of Object.keys(map.eventChannels)) {
    const publishers = getIncoming(map, channel, 'emits', 'dispatches').map((rel) => rel.from);
    const subscribers = getIncoming(map, channel, 'subscribes').map((rel) => rel.from);
    for (const publisher of publishers) {
      for (const subscriber of subscribers) pairs.add(`${publisher} -> ${subscriber}`);
    }
  }
  return [...pairs].sort();
}

/** Event edges to real channels, as `type from -> to`, sorted. */
export function eventEdges(map: ConnectionMap): string[] {
  return map.relationships
    .filter((rel) => EVENT_TYPES.has(rel.type) && !rel.to.startsWith('unresolved:'))
    .map((rel) => `${rel.type} ${rel.from} -> ${rel.to}`)
    .sort();
}

/** Unresolved observations, as `reason | subject`, sorted. */
export function observationsOf(map: ConnectionMap): string[] {
  return Object.values(map.unresolved)
    .map((node) => `${node.reason} | ${node.subject}`)
    .sort();
}

export interface Score {
  readonly expected: number;
  readonly actual: number;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  /** Share of what was produced that was expected; 1 when nothing was produced */
  readonly precision: number;
  /** Share of what was expected that was produced; 1 when nothing was expected */
  readonly recall: number;
}

export function score(expected: readonly string[], actual: readonly string[]): Score {
  const want = new Set(expected);
  const got = new Set(actual);
  const truePositives = [...got].filter((item) => want.has(item)).length;

  return {
    expected: want.size,
    actual: got.size,
    truePositives,
    falsePositives: got.size - truePositives,
    falseNegatives: want.size - truePositives,
    precision: got.size === 0 ? 1 : truePositives / got.size,
    recall: want.size === 0 ? 1 : truePositives / want.size,
  };
}

/** The items in `a` that are not in `b`, sorted. */
export function difference(a: readonly string[], b: readonly string[]): string[] {
  const other = new Set(b);
  return [...new Set(a)].filter((item) => !other.has(item)).sort();
}

export function sum(scores: readonly Score[]): Score {
  const expected = scores.reduce((total, s) => total + s.expected, 0);
  const actual = scores.reduce((total, s) => total + s.actual, 0);
  const truePositives = scores.reduce((total, s) => total + s.truePositives, 0);

  return {
    expected,
    actual,
    truePositives,
    falsePositives: actual - truePositives,
    falseNegatives: expected - truePositives,
    precision: actual === 0 ? 1 : truePositives / actual,
    recall: expected === 0 ? 1 : truePositives / expected,
  };
}

export interface ReportRow {
  readonly name: string;
  readonly limit: boolean;
  readonly pairs: Score;
  readonly observationsMatch: boolean;
  /** `undefined` when the fixture does not pin its exact edges */
  readonly edgesExact: boolean | undefined;
}

const percent = (value: number): string => `${(value * 100).toFixed(0)}%`;

/** A Markdown table of how each fixture scored, plus totals. */
export function formatReport(rows: readonly ReportRow[]): string {
  const header = [
    '| Fixture | Pairs found / expected | Wrong pairs | Observations | Exact edges |',
    '| --- | --- | --- | --- | --- |',
  ];
  const body = rows.map(
    (row) =>
      `| ${row.name} | ${row.pairs.truePositives} / ${row.pairs.expected} | ${row.pairs.falsePositives} | ${
        row.observationsMatch ? 'match' : 'differ'
      } | ${row.edgesExact === undefined ? '-' : row.edgesExact ? 'yes' : 'no'} |`,
  );

  const supported = sum(rows.filter((row) => !row.limit).map((row) => row.pairs));
  const all = sum(rows.map((row) => row.pairs));
  const totals = [
    '',
    `Supported fixtures: recall ${percent(supported.recall)} (${supported.truePositives}/${supported.expected}), precision ${percent(supported.precision)}.`,
    `All fixtures, including known limits: recall ${percent(all.recall)} (${all.truePositives}/${all.expected}), precision ${percent(all.precision)}.`,
  ];

  return [...header, ...body, ...totals].join('\n');
}
