import * as fs from 'fs';
import * as path from 'path';
import { serializeConnectionMap } from '../serialize.js';
import { renderMarkdown } from '../renderer/markdown-renderer.js';
import { getGitCommitHash } from './git-utils.js';
import { loadBalk2ConfigDetailed } from '../config/index.js';
import { buildConnectionGraphDetailed } from './build-graph.js';
import { formatConfigWarnings, formatSyntaxWarnings } from './problem-warnings.js';
import type { ConnectionMap } from '../types.js';
import { collectDiagnostics, type Diagnostic } from './diagnostics.js';

export interface GenerateOptions {
  /** Target root directory to analyze (default: process.cwd()) */
  readonly cwd?: string;
  /** Output directory or base file path (default: "connection-map") */
  readonly output?: string;
  /** Custom timestamp string for testing */
  readonly timestamp?: string;
}

export interface GenerateResult {
  readonly jsonPath: string;
  readonly mdPath: string;
  readonly map: ConnectionMap;
  /** One line per configuration entry that was dropped; printed to stderr by the CLI */
  readonly warnings: readonly string[];
  /** Diagnostics for this run, in deterministic order */
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Scan a repository, construct the ConnectionGraph, and generate connection-map.json & connection-map.md.
 */
export function generateConnectionMap(options: GenerateOptions = {}): GenerateResult {
  const rootDir = path.resolve(options.cwd ?? process.cwd());
  const loaded = loadBalk2ConfigDetailed(rootDir);
  const balk2Config = loaded.config;
  const built = buildConnectionGraphDetailed(rootDir, balk2Config);
  const graph = built.graph;
  const warnings = [
    ...formatConfigWarnings([...loaded.problems, ...built.problems]),
    ...formatSyntaxWarnings(built.syntaxErrors),
  ];

  // Build connection map
  const commit = getGitCommitHash(rootDir);
  const generatedAt = options.timestamp ?? new Date().toISOString();

  const map = graph.build({
    ...(commit ? { commit } : {}),
    generatedAt,
  });

  // Determine output file paths
  const outputTarget = options.output ?? balk2Config?.output;
  const { jsonPath, mdPath } = resolveOutputPaths(rootDir, outputTarget);

  // Ensure output directory exists
  const jsonDir = path.dirname(jsonPath);
  if (!fs.existsSync(jsonDir)) {
    fs.mkdirSync(jsonDir, { recursive: true });
  }

  // Serialize and write artifacts
  const jsonContent = serializeConnectionMap(map);
  const mdContent = renderMarkdown(map);

  fs.writeFileSync(jsonPath, jsonContent, 'utf8');
  fs.writeFileSync(mdPath, mdContent, 'utf8');

  const diagnostics = collectDiagnostics(
    map,
    [...loaded.problems, ...built.problems],
    built.syntaxErrors,
    built.manifestProblems,
    built.moduleProblems,
  );
  return { jsonPath, mdPath, map, warnings, diagnostics };
}

// ── Helpers ─────────────────────────────────────────────────────────

export function resolveOutputPaths(
  rootDir: string,
  outputOption?: string,
): { jsonPath: string; mdPath: string } {
  if (!outputOption) {
    return {
      jsonPath: path.join(rootDir, 'connection-map.json'),
      mdPath: path.join(rootDir, 'connection-map.md'),
    };
  }

  const resolved = path.resolve(rootDir, outputOption);

  if (resolved.endsWith('.json')) {
    const basePath = resolved.slice(0, -5);
    return { jsonPath: resolved, mdPath: `${basePath}.md` };
  }

  if (resolved.endsWith('.md')) {
    const basePath = resolved.slice(0, -3);
    return { jsonPath: `${basePath}.json`, mdPath: resolved };
  }

  // Treat as directory or base name prefix
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    return {
      jsonPath: path.join(resolved, 'connection-map.json'),
      mdPath: path.join(resolved, 'connection-map.md'),
    };
  }

  // Check if target directory exists or parent exists
  if (path.extname(resolved) === '') {
    return {
      jsonPath: path.join(resolved, 'connection-map.json'),
      mdPath: path.join(resolved, 'connection-map.md'),
    };
  }

  return {
    jsonPath: path.join(rootDir, 'connection-map.json'),
    mdPath: path.join(rootDir, 'connection-map.md'),
  };
}
