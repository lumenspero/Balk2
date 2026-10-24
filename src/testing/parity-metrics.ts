import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildConnectionGraphDetailed } from '../cli/build-graph.js';
import type { Balk2Config } from '../config/balk2-config.js';
import type { ConnectionMap } from '../types.js';
import {
  CORPUS_LANGUAGES,
  parseRelationship,
  type CorpusLanguage,
  type CorpusScenario,
  type Expectation,
  type Rendition,
} from './corpus-types.js';
import { PARITY_CORPUS } from './parity-corpus.js';
import { PYTHON_CORPUS } from './python-corpus.js';
import { RUST_CORPUS } from './rust-corpus.js';

export interface CorpusEntry {
  readonly corpus: string;
  readonly language: CorpusLanguage;
  readonly scenario: CorpusScenario;
  readonly rendition: Rendition;
}

/** Every rendition in every parity-style corpus, with the language it belongs to. */
export function corpusEntries(): CorpusEntry[] {
  const out: CorpusEntry[] = [];
  const corpora: ReadonlyArray<readonly [string, readonly CorpusScenario[]]> = [
    ['parity', PARITY_CORPUS],
    ['python', PYTHON_CORPUS],
    ['rust', RUST_CORPUS],
  ];
  for (const [corpus, scenarios] of corpora) {
    for (const scenario of scenarios) {
      for (const language of CORPUS_LANGUAGES) {
        const rendition = scenario.renditions[language];
        if (rendition) out.push({ corpus, language, scenario, rendition });
      }
    }
  }
  return out;
}

/** Writes the repository to a temporary directory and analyzes it like `generate` does. */
export function analyzeFiles(
  files: Readonly<Record<string, string>>,
  config?: Readonly<Record<string, unknown>>,
): {
  map: ConnectionMap;
  syntaxPaths: Set<string>;
  /** Reported diagnostics as `"<kind> <path>"`, from the module tree problems. */
  diagnostics: Set<string>;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-parity-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf8');
    }
    const built = buildConnectionGraphDetailed(root, config as Balk2Config | undefined);
    const map = built.graph.build({ generatedAt: '2026-01-01T00:00:00Z' });
    return {
      map,
      syntaxPaths: new Set(built.syntaxErrors.map((e) => e.path)),
      diagnostics: new Set(
        built.moduleProblems.map((problem) => `${problem.kind} ${problem.path}`),
      ),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export function hasRelationship(map: ConnectionMap, expectation: string): boolean {
  const wanted = parseRelationship(expectation);
  return map.relationships.some(
    (rel) => wanted.types.includes(rel.type) && rel.from === wanted.from && rel.to === wanted.to,
  );
}

/**
 * Positive expectations: each one is a fact the analysis must produce. `noSyntaxErrors` is a
 * negative check, so it is counted with `absent` below.
 */
function positiveCount(want: Expectation): number {
  return (
    (want.relationships?.length ?? 0) +
    (want.symbols?.length ?? 0) +
    (want.syntaxErrors?.length ?? 0) +
    (want.diagnostics?.length ?? 0)
  );
}

/** The outcome of checking one rendition against its expectations. */
export interface Evaluation {
  /** Positive expectations declared by the rendition. */
  readonly positives: number;
  /** Positive expectations the analysis produced. */
  readonly met: number;
  /** Declared negative expectations the analysis violated. Each one is a false positive. */
  readonly falsePositives: number;
  /** Unresolved references the analysis reported for the repository. */
  readonly observations: number;
  /** Human-readable failures, in the same form the parity test reports. */
  readonly unmet: string[];
  /** Wall time to analyze the repository, in milliseconds. */
  readonly ms: number;
}

export function evaluate(entry: CorpusEntry): Evaluation {
  const { expect: want } = entry.rendition;
  const started = performance.now();
  const positives = positiveCount(want);
  let analysis: ReturnType<typeof analyzeFiles>;
  try {
    analysis = analyzeFiles(entry.rendition.files, entry.rendition.config);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      positives,
      met: 0,
      falsePositives: 0,
      observations: 0,
      unmet: [`analysis threw: ${reason}`],
      ms: performance.now() - started,
    };
  }
  const { map, syntaxPaths, diagnostics } = analysis;
  const missing: string[] = [];
  const unexpected: string[] = [];

  for (const rel of want.relationships ?? []) {
    if (!hasRelationship(map, rel)) missing.push(`missing relationship: ${rel}`);
  }
  for (const rel of want.absent ?? []) {
    if (hasRelationship(map, rel)) unexpected.push(`unexpected relationship: ${rel}`);
  }
  for (const symbol of want.symbols ?? []) {
    if (!(symbol in map.symbols)) missing.push(`missing symbol: ${symbol}`);
  }
  for (const file of want.syntaxErrors ?? []) {
    if (!syntaxPaths.has(file)) missing.push(`missing syntax diagnostic: ${file}`);
  }
  if (want.noSyntaxErrors && syntaxPaths.size > 0) {
    unexpected.push(`unexpected syntax diagnostics: ${[...syntaxPaths].join(', ')}`);
  }
  for (const diagnostic of want.diagnostics ?? []) {
    if (!diagnostics.has(diagnostic)) missing.push(`missing diagnostic: ${diagnostic}`);
  }

  return {
    positives,
    met: positives - missing.length,
    falsePositives: unexpected.length,
    observations: Object.keys(map.unresolved).length,
    unmet: [...missing, ...unexpected],
    ms: performance.now() - started,
  };
}

/** One rendition's measurements, with the scenario it came from. */
export interface Measure extends Evaluation {
  readonly corpus: string;
  readonly language: CorpusLanguage;
  readonly family: string;
  readonly scenario: string;
  /** The V3 phase that makes this rendition pass, when it is still pending. */
  readonly pending?: string;
}

/** Measures every rendition in every parity-style corpus, pending ones included. */
export function measureAll(): Measure[] {
  return corpusEntries().map((entry) => ({
    corpus: entry.corpus,
    language: entry.language,
    family: entry.scenario.family,
    scenario: entry.scenario.name,
    pending: entry.rendition.pending,
    ...evaluate(entry),
  }));
}

interface Totals {
  /** Non-pending renditions. */
  renditions: number;
  positives: number;
  met: number;
  falsePositives: number;
  /** Unresolved references, across every rendition. */
  observations: number;
  pending: number;
  pendingPositives: number;
  pendingMet: number;
  ms: number;
}

function emptyTotals(): Totals {
  return {
    renditions: 0,
    positives: 0,
    met: 0,
    falsePositives: 0,
    observations: 0,
    pending: 0,
    pendingPositives: 0,
    pendingMet: 0,
    ms: 0,
  };
}

function addTo(total: Totals, m: Measure): void {
  if (m.pending) {
    total.pending += 1;
    total.pendingPositives += m.positives;
    total.pendingMet += m.met;
  } else {
    total.renditions += 1;
    total.positives += m.positives;
    total.met += m.met;
    total.falsePositives += m.falsePositives;
  }
  total.observations += m.observations;
  total.ms += m.ms;
}

function totalsBy(measures: readonly Measure[], key: (m: Measure) => string): Map<string, Totals> {
  const out = new Map<string, Totals>();
  for (const m of measures) {
    const k = key(m);
    let total = out.get(k);
    if (!total) {
      total = emptyTotals();
      out.set(k, total);
    }
    addTo(total, m);
  }
  return out;
}

const percent = (met: number, positives: number): string =>
  positives === 0 ? 'n/a' : `${((100 * met) / positives).toFixed(1)}%`;

const HEADER = [
  'family',
  'renditions',
  'recall',
  'false pos',
  'unresolved',
  'pending (recall)',
  'time',
];

function row(label: string, t: Totals): string[] {
  return [
    label,
    String(t.renditions),
    percent(t.met, t.positives),
    String(t.falsePositives),
    String(t.observations),
    t.pending > 0 ? `${t.pending} (${percent(t.pendingMet, t.pendingPositives)})` : '0',
    `${(t.ms / 1000).toFixed(1)}s`,
  ];
}

function table(rows: readonly string[][]): string {
  const all = [HEADER, ...rows];
  const widths = HEADER.map((_, i) => Math.max(...all.map((r) => r[i]!.length)));
  return all
    .map((r) =>
      r
        .map((cell, i) => cell.padEnd(widths[i]!))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

/**
 * A per-language table, one row per mechanism family, with a total row. Recall is met over
 * declared positives for non-pending renditions. Pending renditions are shown separately, with
 * their own recall, so the progress they still need stays visible.
 */
export function formatAccuracyReport(measures: readonly Measure[]): string {
  const sections = CORPUS_LANGUAGES.map((language) => {
    const inLanguage = measures.filter((m) => m.language === language);
    const byFamily = totalsBy(inLanguage, (m) => m.family);
    const rows = [...byFamily.keys()].sort().map((family) => row(family, byFamily.get(family)!));
    const total = totalsBy(inLanguage, () => 'all').get('all') ?? emptyTotals();
    rows.push(row('TOTAL', total));
    return `== ${language} ==\n${table(rows)}`;
  });
  const overall = totalsBy(measures, () => 'all').get('all') ?? emptyTotals();
  sections.push(`== all languages ==\n${table([row('TOTAL', overall)])}`);
  return [
    'Parity accuracy. Recall is over non-pending renditions. "unresolved" counts reported unresolved references.',
    ...sections,
  ].join('\n\n');
}

/** Checks one rendition. Returns the list of unmet expectations. */
export function unmetExpectations(entry: CorpusEntry): string[] {
  return evaluate(entry).unmet;
}
