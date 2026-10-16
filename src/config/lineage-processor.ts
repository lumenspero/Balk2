import type { ConnectionGraph } from '../graph.js';
import type { DataLineageEntry } from './balk2-config.js';
import type { ConfigProblem } from './config-problem.js';
import { addDataRelationship } from '../data/data-analyzer.js';
import { normalizePath } from '../path-utils.js';

/**
 * Apply explicit data lineage rules from .balk2.json configuration to the ConnectionGraph.
 *
 * When `repositoryFiles` is given, returns a problem for each entry that cannot be checked
 * against the repository: a producer or consumer script that does not exist, and an input that
 * no repository file provides and no configured output produces. A missing output is not
 * reported, because a pipeline may create it later.
 */
export function applyExplicitLineage(
  lineageRules: readonly DataLineageEntry[],
  graph: ConnectionGraph,
  repositoryFiles?: ReadonlySet<string>,
): ConfigProblem[] {
  for (const entry of lineageRules) {
    // 1. Producer output (producer -> generates -> output)
    if (entry.producer && entry.output) {
      const outputs = toArray(entry.output);
      for (const out of outputs) {
        addDataRelationship(entry.producer, out, 'generates', graph, 'high');
      }
    }

    // 2. Producer input (producer -> consumes -> input)
    if (entry.producer && entry.input) {
      const inputs = toArray(entry.input);
      for (const inp of inputs) {
        addDataRelationship(entry.producer, inp, 'consumes', graph, 'high');
      }
    }

    // 3. Consumer input (consumer -> consumes -> input)
    if (entry.consumer && entry.input) {
      const inputs = toArray(entry.input);
      for (const inp of inputs) {
        addDataRelationship(entry.consumer, inp, 'consumes', graph, 'high');
      }
    }

    // 4. Consumer output (consumer -> generates -> output)
    if (entry.consumer && entry.output) {
      const outputs = toArray(entry.output);
      for (const out of outputs) {
        addDataRelationship(entry.consumer, out, 'generates', graph, 'high');
      }
    }
  }

  return repositoryFiles ? lineageProblems(lineageRules, repositoryFiles) : [];
}

function lineageProblems(
  lineageRules: readonly DataLineageEntry[],
  repositoryFiles: ReadonlySet<string>,
): ConfigProblem[] {
  const known = new Set([...repositoryFiles].map(normalizePath));
  const produced = new Set(lineageRules.flatMap((entry) => outputsOf(entry)).map(normalizePath));

  const problems: ConfigProblem[] = [];
  lineageRules.forEach((entry, index) => {
    const at = `data.lineage[${index}]`;
    for (const role of ['producer', 'consumer'] as const) {
      const script = entry[role];
      if (script !== undefined && !known.has(normalizePath(script))) {
        problems.push({
          path: `${at}.${role}`,
          message: `${script} does not exist in the repository`,
        });
      }
    }
    for (const input of inputsOf(entry)) {
      const path = normalizePath(input);
      if (!known.has(path) && !produced.has(path)) {
        problems.push({
          path: `${at}.input`,
          message: `${input} is not in the repository, and no lineage entry produces it`,
        });
      }
    }
  });
  return problems;
}

function inputsOf(entry: DataLineageEntry): readonly string[] {
  return entry.input === undefined ? [] : toArray(entry.input);
}

function outputsOf(entry: DataLineageEntry): readonly string[] {
  return entry.output === undefined ? [] : toArray(entry.output);
}

function toArray(val: string | readonly string[]): readonly string[] {
  if (Array.isArray(val)) return val;
  return [val as string];
}
