import * as fs from 'fs';
import * as path from 'path';
import type { Analyzer, AnalyzerOptions } from './types.js';
import type { ConnectionGraph } from '../graph.js';
import { normalizePath } from '../graph.js';
import { analyzePythonSources } from './python-front-end.js';

/**
 * Compatibility wrapper for the Python front end (V3 Phase 5.7c). `analyzeFile` analyzes one file
 * with the same passes as build-graph. Imports resolve against `options.knownFiles`, and against
 * the text of files readable under `options.rootDir`. A file's facts that depend on another file's
 * contents are missing when that file is neither readable nor passed in.
 *
 * For a repository, use `PythonFrontEnd`, or `analyzePythonSources`.
 *
 * @deprecated Use `PythonFrontEnd`.
 */
export class PythonAnalyzer implements Analyzer {
  readonly name = 'PythonAnalyzer';
  readonly supportedExtensions: readonly string[] = ['.py'];

  canAnalyze(filePath: string): boolean {
    return normalizePath(filePath).toLowerCase().endsWith('.py');
  }

  analyzeFile(
    filePath: string,
    content: string,
    graph: ConnectionGraph,
    options?: AnalyzerOptions,
  ): void {
    const normalizedPath = normalizePath(filePath);
    const knownFiles = new Set(options?.knownFiles ? toSet(options.knownFiles) : []);
    knownFiles.add(normalizedPath);
    const rootDir = options?.rootDir;
    const readText = (p: string): string =>
      p === normalizedPath ? content : readFromRoot(rootDir, p);
    analyzePythonSources(
      [{ filePath: normalizedPath, source: content }],
      knownFiles,
      readText,
      graph,
    );
  }
}

function readFromRoot(rootDir: string | undefined, filePath: string): string {
  if (rootDir === undefined) return '';
  try {
    return fs.readFileSync(path.join(rootDir, filePath), 'utf8');
  } catch {
    return '';
  }
}

function toSet(knownFiles: ReadonlySet<string> | readonly string[]): ReadonlySet<string> {
  if (knownFiles instanceof Set) return knownFiles;
  return new Set((knownFiles as readonly string[]).map(normalizePath));
}
