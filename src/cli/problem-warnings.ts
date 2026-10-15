import type { ConfigProblem } from '../config/config-problem.js';

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