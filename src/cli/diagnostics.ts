import type { ConnectionMap, UnresolvedReason } from '../types.js';
import type { ConfigProblem } from '../config/config-problem.js';
import type { SyntaxErrorNote } from '../analyzer/repository-program.js';

/**
 * Every unresolved reason. Typed as a record over UnresolvedReason, so a reason added to the type
 * but not listed here is a compile error rather than a diagnostic kind that cannot be selected.
 */
const REASON_KEYS: Record<UnresolvedReason, true> = {
  'ambiguous-global': true,
  'dynamic-event-name': true,
  'unknown-event-receiver': true,
  'dynamic-registry-key': true,
  'unknown-registry-receiver': true,
  'ambiguous-registry': true,
  'dynamic-state-path': true,
  'dynamic-module-specifier': true,
  'unresolved-callback': true,
  'unresolved-metadata-key': true,
  'dynamic-resource-specifier': true,
  'unresolved-module-path': true,
  'ambiguous-star-import': true,
  'dynamic-include-path': true,
  'unresolved-binding': true,
};

/** The kinds `--fail-on` accepts: parse failures, ignored configuration, and each unresolved reason. */
export const DIAGNOSTIC_KINDS = [
  'syntax',
  'config',
  'manifest',
  'unreachable-module',
  'module-conflict',
  'shadowed-module',
  ...(Object.keys(REASON_KEYS) as UnresolvedReason[]),
] as const;
export type DiagnosticKind = (typeof DIAGNOSTIC_KINDS)[number];

/** One finding a CI run can fail on. Lines and columns are 1-based when present. */
export interface Diagnostic {
  readonly kind: DiagnosticKind;
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  readonly message: string;
}

/** Path used for problems that come from `.balk2.json` rather than a source file. */
const CONFIG_PATH = '.balk2.json';

/**
 * The diagnostics for one run, in a fixed order: by path, then line, column, kind, and message. The
 * sort uses code-unit comparison, not the locale, so output is the same on every machine. Internal
 * unresolved references are skipped because nothing in the repository can act on them.
 */
export function collectDiagnostics(
  map: ConnectionMap,
  problems: readonly ConfigProblem[],
  syntaxErrors: readonly SyntaxErrorNote[],
): Diagnostic[] {
  const found: Diagnostic[] = [];

  for (const error of syntaxErrors) {
    found.push({
      kind: 'syntax',
      path: error.path,
      line: error.line,
      column: error.column,
      message: error.message,
    });
  }

  for (const problem of problems) {
    found.push({
      kind: 'config',
      path: CONFIG_PATH,
      message: problem.path ? `${problem.path}: ${problem.message}` : problem.message,
    });
  }

  for (const node of Object.values(map.unresolved)) {
    if (node.tier === 'internal') continue;
    found.push({
      kind: node.reason,
      path: node.location.filePath,
      line: node.location.startLine,
      column: node.location.startColumn,
      message: node.detail ? `${node.subject}: ${node.detail}` : node.subject,
    });
  }

  return found.sort(compareDiagnostics);
}

/** Parse a `--fail-on` value such as `syntax,ambiguous-global`. Throws a message naming the problem. */
export function parseFailOn(text: string): DiagnosticKind[] {
  const items = text
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (items.length === 0) throw new Error('--fail-on needs at least one kind');

  const kinds: DiagnosticKind[] = [];
  for (const item of items) {
    if (!(DIAGNOSTIC_KINDS as readonly string[]).includes(item)) {
      throw new Error(
        `--fail-on: unknown kind "${item}" (expected ${DIAGNOSTIC_KINDS.join(', ')})`,
      );
    }
    const kind = item as DiagnosticKind;
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}

/**
 * The stderr lines for a failing run: one per diagnostic whose kind was selected, then a summary.
 * Empty when nothing matched, so the caller exits 0.
 */
export function failureLines(
  diagnostics: readonly Diagnostic[],
  kinds: readonly DiagnosticKind[],
): string[] {
  const failing = diagnostics.filter((diagnostic) => kinds.includes(diagnostic.kind));
  if (failing.length === 0) return [];

  const lines = failing.map((diagnostic) => {
    const location =
      diagnostic.line === undefined
        ? diagnostic.path
        : `${diagnostic.path}:${diagnostic.line}:${diagnostic.column ?? 0}`;
    return `balk2 diagnostic [${diagnostic.kind}]: ${location}: ${diagnostic.message}`;
  });
  lines.push(
    `balk2: ${failing.length} diagnostic${failing.length === 1 ? '' : 's'} matched --fail-on ` +
      `(${kinds.join(', ')})`,
  );
  return lines;
}

function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  return (
    compareText(a.path, b.path) ||
    (a.line ?? 0) - (b.line ?? 0) ||
    (a.column ?? 0) - (b.column ?? 0) ||
    compareText(a.kind, b.kind) ||
    compareText(a.message, b.message)
  );
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
