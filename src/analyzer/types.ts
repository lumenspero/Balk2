import type { ConnectionGraph } from '../graph.js';
import type { RepositoryProgram } from './repository-program.js';

/**
 * Options passed to analyzers during repository analysis.
 */
export interface AnalyzerOptions {
  /**
   * Root directory of the repository (used for filesystem resolution if needed).
   */
  readonly rootDir?: string;
  /**
   * Set of all relative file paths known in the repository.
   * Enables strict import path resolution against existing files.
   */
  readonly knownFiles?: ReadonlySet<string> | readonly string[];
  /** Shared repository analysis session, when the caller has one. */
  readonly repository?: RepositoryProgram;
}

/**
 * Interface that all language-specific source code analyzers must implement.
 */
export interface Analyzer {
  /**
   * Human-readable name of the analyzer (e.g. "JsTsAnalyzer").
   */
  readonly name: string;
  /**
   * Supported file extensions (including leading dot, e.g. ['.ts', '.js']).
   */
  readonly supportedExtensions: readonly string[];
  /**
   * Check if this analyzer can handle the given file path.
   */
  canAnalyze(filePath: string): boolean;
  /**
   * Analyze the content of a single source file and populate the ConnectionGraph.
   */
  analyzeFile(
    filePath: string,
    content: string,
    graph: ConnectionGraph,
    options?: AnalyzerOptions,
  ): void;
}
