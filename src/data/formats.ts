import type { ArtifactFormat, ResourceKind } from '../types.js';
import { normalizePath } from '../graph.js';
import type { ConnectionGraph } from '../graph.js';
import { detectManifestKind } from './manifests.js';

/**
 * Mapping of file extensions to ArtifactFormat.
 */
const EXTENSION_FORMAT_MAP: Record<string, ArtifactFormat> = {
  '.json': 'json',
  '.jsonl': 'jsonl',
  '.ndjson': 'jsonl',
  '.csv': 'csv',
  '.tsv': 'tsv',
  '.parquet': 'parquet',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml',
  '.sqlite': 'sqlite',
  '.sqlite3': 'sqlite',
  '.db': 'sqlite',
};

/** Extensions of markup templates. */
const TEMPLATE_EXTENSIONS: readonly string[] = [
  '.html',
  '.htm',
  '.hbs',
  '.handlebars',
  '.ejs',
  '.mustache',
];

/** Extensions of stylesheets. */
const STYLESHEET_EXTENSIONS: readonly string[] = ['.css', '.scss', '.sass', '.less'];

/** The suffix that makes a JSON file a schema resource rather than a data artifact. */
const SCHEMA_SUFFIX = '.schema.json';

/**
 * Supported data file extensions.
 */
export const SUPPORTED_DATA_EXTENSIONS: readonly string[] = Object.keys(EXTENSION_FORMAT_MAP);

/**
 * Detect the ArtifactFormat of a file path based on its extension. A `*.schema.json` file is a
 * schema resource, not a data artifact, so it has no artifact format.
 */
export function detectArtifactFormat(filePath: string): ArtifactFormat | undefined {
  const norm = normalizePath(filePath).toLowerCase();
  if (norm.endsWith(SCHEMA_SUFFIX)) return undefined;
  for (const [ext, format] of Object.entries(EXTENSION_FORMAT_MAP)) {
    if (norm.endsWith(ext)) {
      return format;
    }
  }
  return undefined;
}

/**
 * Detect the ResourceKind of a file path: a template, a stylesheet or a schema. Returns undefined
 * for anything else, including plain data files.
 */
export function detectResourceKind(filePath: string): ResourceKind | undefined {
  const norm = normalizePath(filePath).toLowerCase();
  if (norm.endsWith(SCHEMA_SUFFIX)) return 'schema';
  if (TEMPLATE_EXTENSIONS.some((ext) => norm.endsWith(ext))) return 'template';
  if (STYLESHEET_EXTENSIONS.some((ext) => norm.endsWith(ext))) return 'stylesheet';
  return undefined;
}

/**
 * Check if a file path is a recognized data artifact.
 */
export function isDataArtifact(filePath: string): boolean {
  return detectArtifactFormat(filePath) !== undefined;
}

/**
 * Make an import target a node. A JSON file is an artifact node, created when code imports or
 * requires it. Other targets are file nodes already.
 */
export function ensureImportTarget(graph: ConnectionGraph, target: string): void {
  if (graph.hasFile(target) || graph.hasArtifact(target)) return;
  if (detectArtifactFormat(target) === 'json') graph.addArtifact(target, 'json');
}

/**
 * Scan a list of file paths and add all recognized data artifacts as ArtifactNodes to the graph.
 * JSON files are left out here; they are added when code references them.
 */
export function registerDataArtifacts(
  filePaths: readonly string[],
  graph: ConnectionGraph,
): string[] {
  const registered: string[] = [];
  for (const path of filePaths) {
    // Manifests are file nodes, registered by registerManifests, not data artifacts.
    if (detectManifestKind(path)) continue;
    const format = detectArtifactFormat(path);
    // JSON becomes an artifact only when code references it (see ensureImportTarget).
    if (format && format !== 'json') {
      const norm = normalizePath(path);
      graph.addArtifact(norm, format);
      registered.push(norm);
    }
  }
  return registered;
}
