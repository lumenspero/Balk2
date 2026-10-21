import * as fs from 'fs';
import * as path from 'path';
import { ConnectionGraph, normalizePath } from '../graph.js';
import { applyAnnotations, type Annotation } from '../analyzer/annotations.js';
import type { FrontEndInput, FrontEndSourceAnnotations } from '../analyzer/front-end.js';
import { JsTsFrontEnd } from '../analyzer/js-ts-front-end.js';
import { LegacyPythonFrontEnd } from '../analyzer/legacy-python-front-end.js';
import { registerDataArtifacts } from '../data/formats.js';
import { filterFilesWithConfig, applyExplicitLineage } from '../config/index.js';
import type { Balk2Config } from '../config/balk2-config.js';
import type { ConfigProblem } from '../config/config-problem.js';
import type { SyntaxErrorNote } from '../analyzer/repository-program.js';

const DEFAULT_EXCLUDES = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.github',
  '.idea',
  '.vscode',
  'connection-map.json',
  'connection-map.md',
]);

/** The graph, and what the analysis dropped that the configuration asked for. */
export interface BuiltGraph {
  readonly graph: ConnectionGraph;
  /** Configured entries the analysis could not use, such as a singleton with no export */
  readonly problems: readonly ConfigProblem[];
  /** Syntax errors in analyzed source files. The graph is still built from the recovered trees. */
  readonly syntaxErrors: readonly SyntaxErrorNote[];
}

/**
 * Build the connection graph for a repository, with the problems the analysis reported.
 *
 * This is the single analysis path shared by `generate` and `check`. Both
 * commands must produce byte-identical graphs for identical input, so no
 * analysis logic may live outside this function.
 *
 * The steps run in a fixed order that does not depend on language (V3 plan, Phase 1.2):
 * scan, package discovery, front ends, binding index, cross-language resolution, mechanism
 * engines, explicit lineage, annotations.
 */
export function buildConnectionGraphDetailed(rootDir: string, config?: Balk2Config): BuiltGraph {
  const graph = new ConnectionGraph();
  const problems: ConfigProblem[] = [];
  const configAnnotations: readonly Annotation[] = config?.annotations ?? [];

  // 1. Scan. Every later step sees only these files, after the configured include/exclude filters.
  const rawFiles = scanRepositoryFiles(rootDir);
  const files = filterFilesWithConfig(rawFiles, config?.include, config?.exclude);

  // 2. Package discovery. Empty until Phase 4 (Python) and Phase 7 (Cargo and npm) add packages.

  // 3. Front ends, in a fixed order: JS/TS, then Python. Data artifacts are registered first so
  //    the front ends see them.
  registerDataArtifacts(files, graph);
  const input: FrontEndInput = { rootDir, files, config };
  const jsTsResult = new JsTsFrontEnd().analyze(input, graph);
  const pythonResult = new LegacyPythonFrontEnd().analyze(input, graph);
  problems.push(...jsTsResult.problems, ...pythonResult.problems);
  const syntaxErrors: readonly SyntaxErrorNote[] = [
    ...jsTsResult.syntaxErrors,
    ...pythonResult.syntaxErrors,
  ];

  // 4. Binding index. Empty until Phase 14 (cross-language boundaries).

  // 5. Cross-language resolution. Empty until Phase 14.

  // 6. Mechanism engines. In Phase 1 they still run inside each front end (JS/TS in
  //    analyzeRepository). Phase 2 moves them out of the front ends.

  // 7. Explicit data lineage from .balk2.json. Runs before annotations, which may target lineage edges.
  if (config?.data?.lineage) {
    // Checked against every file in the repository, not only the included ones, so a script
    // outside `include` is not reported as missing.
    problems.push(...applyExplicitLineage(config.data.lineage, graph, new Set(rawFiles)));
  }

  // 8. Project annotations, last, so they see the final edges and no detector overwrites them.
  //    Source comments (JS and Python) take priority over .balk2.json annotations for the same edge.
  //    A repository with no JS/TS files gets the config annotations back as its JS/TS source
  //    annotations. This is the former behavior, kept for zero diff. It makes each config
  //    annotation report a false "set in a source comment" problem. Fixing that is a separate change.
  const jsTsSource: FrontEndSourceAnnotations = jsTsResult.sourceAnnotations ?? {
    annotations: configAnnotations,
    problems: [],
  };
  const pythonSource: FrontEndSourceAnnotations = pythonResult.sourceAnnotations ?? {
    annotations: [],
    problems: [],
  };
  const sourceAnnotations = mergeSourceAnnotations(
    [...jsTsSource.annotations, ...pythonSource.annotations],
    configAnnotations,
  );
  for (const problem of [
    ...jsTsSource.problems,
    ...pythonSource.problems,
    ...sourceAnnotations.problems,
  ]) {
    problems.push({ path: problem.path, message: problem.message });
  }
  const annotationProblems = applyAnnotations(graph, sourceAnnotations.annotations);
  for (const problem of annotationProblems) {
    problems.push({ path: problem.path, message: problem.message });
  }

  return { graph, problems, syntaxErrors };
}

/**
 * Merge source-comment annotations with config annotations. A source annotation for an edge
 * replaces any config annotation for the same edge, and the replaced config entry is reported.
 */
function mergeSourceAnnotations(
  source: readonly Annotation[],
  config: readonly Annotation[],
): { annotations: Annotation[]; problems: { path: string; message: string }[] } {
  const key = (a: Annotation): string => `${a.type}\u0000${a.from}\u0000${a.to}`;
  const sourceKeys = new Set(source.map(key));
  const problems: { path: string; message: string }[] = [];
  const merged: Annotation[] = [...source];
  for (const annotation of config) {
    if (sourceKeys.has(key(annotation))) {
      problems.push({
        path: 'annotations',
        message: `${annotation.type} from ${annotation.from} to ${annotation.to} is set in a source comment; the config annotation is ignored`,
      });
      continue;
    }
    merged.push(annotation);
  }
  return { annotations: merged, problems };
}

/** The connection graph alone, for callers that do not report problems. */
export function buildConnectionGraph(rootDir: string, config?: Balk2Config): ConnectionGraph {
  return buildConnectionGraphDetailed(rootDir, config).graph;
}

/** Recursively list repository-relative files, sorted, skipping default excludes. */
export function scanRepositoryFiles(dir: string, baseDir: string = dir): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (DEFAULT_EXCLUDES.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    const relPath = normalizePath(path.relative(baseDir, fullPath));

    if (entry.isDirectory()) {
      results.push(...scanRepositoryFiles(fullPath, baseDir));
    } else if (entry.isFile()) {
      results.push(relPath);
    }
  }

  return results.sort();
}
