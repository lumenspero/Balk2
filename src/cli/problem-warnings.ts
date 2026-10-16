import type { ConfigProblem } from '../config/config-problem.js';
import type { SyntaxErrorNote } from '../analyzer/repository-program.js';

/**
 * One stderr line per dropped entry in `.balk2.json`, so a mistyped setting is visible instead of
 * silently doing nothing. Used by `generate` and `check`; the graph itself is unaffected.
 */
export function formatConfigWarnings(problems: readonly ConfigProblem[]): string[] {
  return problems.map((problem) => {
    const location = problem.path ? `${problem.path}: ` : '';
    return `balk2 warning: .balk2.json: ${location}${problem.message}`;
  });
}

/**
 * One stderr line per syntax error in an analyzed source file. The analysis still ran on the
 * recovered tree, so that file's connections may be incomplete.
 */
export function formatSyntaxWarnings(errors: readonly SyntaxErrorNote[]): string[] {
  return errors.map(
    (error) =>
      `balk2 warning: ${error.path}:${error.line}:${error.column}: syntax error, ` +
      `connections from this file may be incomplete: ${error.message}`,
  );
}
