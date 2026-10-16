import * as fs from 'fs';
import * as path from 'path';
import { ConnectionGraph, normalizePath } from '../graph.js';
import {
  createRepositoryProgram,
  JsTsAnalyzer,
  PythonAnalyzer,
  type Analyzer,
} from '../analyzer/index.js';
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
  const analyzers: Analyzer[] = [new PythonAnalyzer()];
  const graph = new ConnectionGraph();
  const problems: ConfigProblem[] = [];
  const configAnnotations: readonly Annotation[] = config?.annotations ?? [];

  // 1. Scan directory for repository files & apply config filters
  const rawFiles = scanRepositoryFiles(rootDir);
  const allRelativeFiles = filterFilesWithConfig(rawFiles, config?.include, config?.exclude);

  // 2. Register data artifacts
  registerDataArtifacts(allRelativeFiles, graph);

  // 3. Apply explicit data lineage rules from .balk2.json
  if (config?.data?.lineage) {
    applyExplicitLineage(config.data.lineage, graph);
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
  }

  // 5. Analyze files for language analyzers that do not yet use the shared session.
  //    Python source directives are read from the same files the Python analyzer reads.
  const pythonFiles: Record<string, string> = {};
  for (const relFile of allRelativeFiles) {
    for (const analyzer of analyzers) {
      if (analyzer.canAnalyze(relFile)) {
        try {
          const content = fs.readFileSync(path.join(rootDir, relFile), 'utf8');
          pythonFiles[normalizePath(relFile)] = content;
          analyzer.analyzeFile(relFile, content, graph, {
            rootDir,
            knownFiles: allRelativeFiles,
          });
        } catch {
          // Skip unreadable files gracefully
        }
      }
    }
  }
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

  return { graph, problems };
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
