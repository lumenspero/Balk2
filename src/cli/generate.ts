import * as fs from 'fs';
import * as path from 'path';
import { ConnectionGraph, normalizePath } from '../graph.js';
import { serializeConnectionMap } from '../serialize.js';
import { renderMarkdown } from '../renderer/markdown-renderer.js';
import {
  createRepositoryProgram,
  JsTsAnalyzer,
  PythonAnalyzer,
  type Analyzer,
} from '../analyzer/index.js';
import { registerDataArtifacts } from '../data/formats.js';
import { getGitCommitHash } from './git-utils.js';
import { loadBalk2Config, filterFilesWithConfig, applyExplicitLineage } from '../config/index.js';
import type { ConnectionMap } from '../types.js';

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
}

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

/**
 * Scan a repository, construct the ConnectionGraph, and generate connection-map.json & connection-map.md.
 */
export function generateConnectionMap(options: GenerateOptions = {}): GenerateResult {
  const rootDir = path.resolve(options.cwd ?? process.cwd());
  const balk2Config = loadBalk2Config(rootDir);
  const jsTsAnalyzer = new JsTsAnalyzer();
  const analyzers: Analyzer[] = [new PythonAnalyzer()];
  const graph = new ConnectionGraph();

  // 1. Scan directory for repository files & apply config filters
  const rawFiles = scanFiles(rootDir);
  const allRelativeFiles = filterFilesWithConfig(
    rawFiles,
    balk2Config?.include,
    balk2Config?.exclude,
  );

  // 2. Register data artifacts
  registerDataArtifacts(allRelativeFiles, graph);

  // 3. Apply explicit data lineage rules from .balk2.json
  if (balk2Config?.data?.lineage) {
    applyExplicitLineage(balk2Config.data.lineage, graph);
  }

  // 4. Parse and analyze JS/TS once through a shared repository session.
  const jsTsFiles = allRelativeFiles.filter((filePath) => jsTsAnalyzer.canAnalyze(filePath));
  if (jsTsFiles.length > 0) {
    const repository = createRepositoryProgram({ rootDir, filePaths: jsTsFiles });
    jsTsAnalyzer.analyzeRepository(repository, graph);
  }

  // 5. Analyze files for language analyzers that do not yet use the shared session.
  for (const relFile of allRelativeFiles) {
    for (const analyzer of analyzers) {
      if (analyzer.canAnalyze(relFile)) {
        const fullPath = path.join(rootDir, relFile);
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
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

  // 6. Build connection map
  const commit = getGitCommitHash(rootDir);
  const generatedAt = options.timestamp ?? new Date().toISOString();

  const map = graph.build({
    ...(commit ? { commit } : {}),
    generatedAt,
  });

  // 7. Determine output file paths
  const outputTarget = options.output ?? balk2Config?.output;
  const { jsonPath, mdPath } = resolveOutputPaths(rootDir, outputTarget);

  // Ensure output directory exists
  const jsonDir = path.dirname(jsonPath);
  if (!fs.existsSync(jsonDir)) {
    fs.mkdirSync(jsonDir, { recursive: true });
  }

  // 8. Serialize and write artifacts
  const jsonContent = serializeConnectionMap(map);
  const mdContent = renderMarkdown(map);

  fs.writeFileSync(jsonPath, jsonContent, 'utf8');
  fs.writeFileSync(mdPath, mdContent, 'utf8');

  return { jsonPath, mdPath, map };
}

// ── Helpers ─────────────────────────────────────────────────────────

function scanFiles(dir: string, baseDir: string = dir): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (DEFAULT_EXCLUDES.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    const relPath = normalizePath(path.relative(baseDir, fullPath));

    if (entry.isDirectory()) {
      results.push(...scanFiles(fullPath, baseDir));
    } else if (entry.isFile()) {
      results.push(relPath);
    }
  }

  return results.sort();
}

function resolveOutputPaths(
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
