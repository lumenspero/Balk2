import * as fs from 'fs';
import * as path from 'path';
import { ConnectionGraph, normalizePath } from '../graph.js';
import {
  createRepositoryProgram,
  JsTsAnalyzer,
  PythonAnalyzer,
  type Analyzer,
} from '../analyzer/index.js';
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
  let problems: readonly ConfigProblem[] = [];

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
  const jsTsFiles = allRelativeFiles.filter((filePath) => jsTsAnalyzer.canAnalyze(filePath));
  if (jsTsFiles.length > 0) {
    const repository = createRepositoryProgram({ rootDir, filePaths: jsTsFiles });
    problems = jsTsAnalyzer.analyzeRepository(repository, graph, {
      globals: config?.globals,
      events: config?.protocols?.events,
      registries: config?.protocols?.registries,
      loaders: config?.protocols?.loaders,
      callbacks: config?.protocols?.callbacks,
      metadata: config?.protocols?.metadata,
      resources: config?.protocols?.resources,
      state: config?.state,
    }).stateProblems;
  }

  // 5. Analyze files for language analyzers that do not yet use the shared session.
  for (const relFile of allRelativeFiles) {
    for (const analyzer of analyzers) {
      if (analyzer.canAnalyze(relFile)) {
        try {
          const content = fs.readFileSync(path.join(rootDir, relFile), 'utf8');
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

  return { graph, problems };
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
