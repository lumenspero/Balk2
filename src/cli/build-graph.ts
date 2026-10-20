import * as fs from 'fs';
import * as path from 'path';
import { ConnectionGraph, normalizePath } from '../graph.js';
import { createRepositoryProgram, JsTsAnalyzer } from '../analyzer/index.js';
import { LegacyPythonFrontEnd } from '../analyzer/legacy-python-front-end.js';
import { applyAnnotations, type Annotation } from '../analyzer/annotations.js';
import {
  collectSourceAnnotations,
  type SourceAnnotationResult,
} from '../analyzer/source-annotations-apply.js';
import { collectPythonSourceAnnotations } from '../analyzer/python-source-apply.js';
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
 */
export function buildConnectionGraphDetailed(rootDir: string, config?: Balk2Config): BuiltGraph {
  const jsTsAnalyzer = new JsTsAnalyzer();
  const graph = new ConnectionGraph();
  const problems: ConfigProblem[] = [];
  let syntaxErrors: readonly SyntaxErrorNote[] = [];
  const configAnnotations: readonly Annotation[] = config?.annotations ?? [];

  // 1. Scan directory for repository files & apply config filters
  const rawFiles = scanRepositoryFiles(rootDir);
  const allRelativeFiles = filterFilesWithConfig(rawFiles, config?.include, config?.exclude);

  // 2. Register data artifacts
  registerDataArtifacts(allRelativeFiles, graph);

  // 3. Apply explicit data lineage rules from .balk2.json
  if (config?.data?.lineage) {
    // Checked against every file in the repository, not only the included ones, so a script
    // outside `include` is not reported as missing.
    problems.push(...applyExplicitLineage(config.data.lineage, graph, new Set(rawFiles)));
  }

  // 4. Parse and analyze JS/TS once through a shared repository session.
  //    Source annotations are read in the same session, so they see the same parsed files.
  let jsSource: SourceAnnotationResult = { annotations: configAnnotations, problems: [] };
  const jsTsFiles = allRelativeFiles.filter((filePath) => jsTsAnalyzer.canAnalyze(filePath));
  if (jsTsFiles.length > 0) {
    const repository = createRepositoryProgram({ rootDir, filePaths: jsTsFiles });
    const analysis = jsTsAnalyzer.analyzeRepository(repository, graph, {
      globals: config?.globals,
      events: config?.protocols?.events,
      registries: config?.protocols?.registries,
      loaders: config?.protocols?.loaders,
      callbacks: config?.protocols?.callbacks,
      metadata: config?.protocols?.metadata,
      resources: config?.protocols?.resources,
      state: config?.state,
    });
    problems.push(...analysis.stateProblems);
    jsSource = collectSourceAnnotations(repository, []);
    syntaxErrors = repository.syntaxErrors();
  }

  // 5. Python, through the temporary per-file adapter (Phase 1.1, removed in Phase 5.7).
  //    The adapter's source texts feed the temporary Python source-annotation collector, which
  //    reads the same files the Python analyzer reads (removed in Phase 12.7).
  const pythonResult = new LegacyPythonFrontEnd().analyze(
    { rootDir, files: allRelativeFiles, config },
    graph,
  );
  problems.push(...pythonResult.problems);
  const pythonFiles: Record<string, string> = Object.fromEntries(pythonResult.sourceTexts ?? []);
  const pythonSource = collectPythonSourceAnnotations(pythonFiles, []);

  // 6. Apply project annotations last, so they see the final edges and no detector overwrites them.
  //    Source comments (JS and Python) take priority over .balk2.json annotations for the same edge.
  const sourceAnnotations = mergeSourceAnnotations(
    [...jsSource.annotations, ...pythonSource.annotations],
    configAnnotations,
  );
  for (const problem of [
    ...jsSource.problems,
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
