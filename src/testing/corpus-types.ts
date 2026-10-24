/**
 * Shared types for the V3 parity and language corpora.
 *
 * An expectation is a string `"<types> <from> -> <to>"`, where `<types>` is one relationship type,
 * or several joined with `|` when the language may legitimately use either (for example
 * `consumes|reads`). The same grammar is used by the V2 corpora as `"<from> -> <to>"`, so the V3
 * strings are an extension, not a replacement.
 *
 * Expectations are written from what the code means. They are never copied from tool output.
 */

export type CorpusLanguage = 'javascript' | 'python' | 'rust';

export const CORPUS_LANGUAGES: readonly CorpusLanguage[] = ['javascript', 'python', 'rust'];

/** A reason a language cannot express a scenario, based on language semantics. */
export type NotApplicableReason = string;

/** A phase identifier from the V3 plan, for example `"5"` or `"12.1"`. */
export type PendingPhase = string;

export interface Expectation {
  /** Relationships that must be present, as `"<types> <from> -> <to>"`. */
  readonly relationships?: readonly string[];
  /** Relationships that must not be present, in the same form. */
  readonly absent?: readonly string[];
  /** Symbol ids that must be present. */
  readonly symbols?: readonly string[];
  /** Repository-relative paths that must have a syntax diagnostic. */
  readonly syntaxErrors?: readonly string[];
  /** When true, the repository must produce no syntax diagnostics at all. */
  readonly noSyntaxErrors?: boolean;
  /** Diagnostics that must be reported, as `"<kind> <path>"`, for example `"unreachable-module src/x.rs"`. */
  readonly diagnostics?: readonly string[];
}

export interface Rendition {
  /** Repository files, keyed by repository-relative path. */
  readonly files: Readonly<Record<string, string>>;
  readonly expect: Expectation;
  /** Set when the language does not yet support the scenario. Not a failing test. */
  readonly pending?: PendingPhase;
  /**
   * Configuration for the analysis, in the shape of `.balk2.json`. A scenario that depends on a
   * configured recipe, such as an attribute registration, states the recipe here.
   */
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface CorpusScenario {
  readonly name: string;
  /** Mechanism family from `docs/v3/language-parity.md`. */
  readonly family: string;
  /** One rendition per language, or a reason that the language cannot express it. */
  readonly renditions: Readonly<Partial<Record<CorpusLanguage, Rendition>>>;
  readonly notApplicable?: Readonly<Partial<Record<CorpusLanguage, NotApplicableReason>>>;
}

/** Scenario names that must be unique across a corpus. */
export function assertUniqueNames(scenarios: readonly CorpusScenario[]): void {
  const seen = new Set<string>();
  for (const scenario of scenarios) {
    if (seen.has(scenario.name)) throw new Error(`Duplicate corpus scenario: ${scenario.name}`);
    seen.add(scenario.name);
  }
}

/** A parsed expectation: the relationship types, then the endpoints. */
export interface ParsedRelationship {
  readonly types: readonly string[];
  readonly from: string;
  readonly to: string;
}

export function parseRelationship(text: string): ParsedRelationship {
  const match = /^(\S+) (.+?) -> (.+)$/.exec(text);
  if (!match) throw new Error(`Malformed expectation: ${text}`);
  return {
    types: match[1]!.split('|'),
    from: match[2]!,
    to: match[3]!,
  };
}
