import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildConnectionGraphDetailed } from '../cli/build-graph.js';
import {
  CORPUS_LANGUAGES,
  parseRelationship,
  type CorpusLanguage,
  type CorpusScenario,
  type Rendition,
} from '../testing/corpus-types.js';
import { PARITY_CORPUS } from '../testing/parity-corpus.js';
import { PYTHON_CORPUS } from '../testing/python-corpus.js';
import { RUST_CORPUS } from '../testing/rust-corpus.js';
import type { ConnectionMap } from '../types.js';

// Each case writes a repository and runs the full analysis, so keep the default 5s limit out of the way.
vi.setConfig({ testTimeout: 60_000 });

interface CorpusEntry {
  readonly corpus: string;
  readonly language: CorpusLanguage;
  readonly scenario: CorpusScenario;
  readonly rendition: Rendition;
}

/** Every rendition in every corpus, with the language it belongs to. */
function entries(): CorpusEntry[] {
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
function analyzeFiles(files: Readonly<Record<string, string>>): {
  map: ConnectionMap;
  syntaxPaths: Set<string>;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-parity-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf8');
    }
    const built = buildConnectionGraphDetailed(root);
    const map = built.graph.build({ generatedAt: '2026-01-01T00:00:00Z' });
    return {
      map,
      syntaxPaths: new Set(built.syntaxErrors.map((e) => e.path)),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function hasRelationship(map: ConnectionMap, expectation: string): boolean {
  const wanted = parseRelationship(expectation);
  return map.relationships.some(
    (rel) => wanted.types.includes(rel.type) && rel.from === wanted.from && rel.to === wanted.to,
  );
}

/** Checks one non-pending rendition. Returns the list of unmet expectations. */
function unmetExpectations(entry: CorpusEntry): string[] {
  const { expect: want } = entry.rendition;
  const { map, syntaxPaths } = analyzeFiles(entry.rendition.files);
  const unmet: string[] = [];

  for (const rel of want.relationships ?? []) {
    if (!hasRelationship(map, rel)) unmet.push(`missing relationship: ${rel}`);
  }
  for (const rel of want.absent ?? []) {
    if (hasRelationship(map, rel)) unmet.push(`unexpected relationship: ${rel}`);
  }
  for (const symbol of want.symbols ?? []) {
    if (!(symbol in map.symbols)) unmet.push(`missing symbol: ${symbol}`);
  }
  for (const file of want.syntaxErrors ?? []) {
    if (!syntaxPaths.has(file)) unmet.push(`missing syntax diagnostic: ${file}`);
  }
  if (want.noSyntaxErrors && syntaxPaths.size > 0) {
    unmet.push(`unexpected syntax diagnostics: ${[...syntaxPaths].join(', ')}`);
  }
  if (want.diagnostics && want.diagnostics.length > 0) {
    // Diagnostic kinds such as unreachable-module are added in later phases. Until then, a
    // non-pending rendition cannot meet a diagnostic expectation.
    unmet.push(`diagnostics not yet reported: ${want.diagnostics.join(', ')}`);
  }
  return unmet;
}

const ALL = entries();

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
      expect(unmetExpectations(entry)).toEqual([]);
    },
  );

  it.each(ALL.filter((e) => e.rendition.pending))(
    'pending $corpus / $language: $scenario.name (phase $rendition.pending)',
    () => {
      // Pending renditions are targets. Each phase removes its own marker.
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
