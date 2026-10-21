import type { ConnectionGraph } from '../graph.js';
import { normalizePath } from '../graph.js';

/**
 * The ecosystem a manifest or tool configuration belongs to. It is the language tag of the file
 * node. Manifests are file nodes, not data artifacts (V3 Phase 1.4).
 */
export type ManifestKind = 'npm-manifest' | 'python-manifest' | 'cargo-manifest';

/** Python tool and package configuration, by basename. */
const PYTHON_MANIFESTS: ReadonlySet<string> = new Set([
  'pyproject.toml',
  'setup.cfg',
  'ruff.toml',
  'mypy.ini',
]);

/** Rust toolchain and build configuration, by basename. `.cargo/config.toml` is matched by path. */
const CARGO_MANIFESTS: ReadonlySet<string> = new Set([
  'cargo.toml',
  'rust-toolchain.toml',
  'rustfmt.toml',
  'clippy.toml',
]);

/**
 * The manifest kind of a repository file, or undefined for an ordinary file. Names are matched
 * case-insensitively, because Windows file systems are case-insensitive.
 */
export function detectManifestKind(filePath: string): ManifestKind | undefined {
  const norm = normalizePath(filePath).toLowerCase();
  const base = norm.slice(norm.lastIndexOf('/') + 1);

  if (norm === '.cargo/config.toml' || norm.endsWith('/.cargo/config.toml')) {
    return 'cargo-manifest';
  }
  // A `*.schema.json` file is a schema resource, not a tsconfig.
  if (base.endsWith('.schema.json')) return undefined;
  if (base === 'package.json' || /^tsconfig.*\.json$/.test(base)) return 'npm-manifest';
  if (PYTHON_MANIFESTS.has(base)) return 'python-manifest';
  if (CARGO_MANIFESTS.has(base)) return 'cargo-manifest';
  return undefined;
}

/** Add a file node, tagged with its ecosystem, for every manifest in the list. */
export function registerManifests(filePaths: readonly string[], graph: ConnectionGraph): string[] {
  const registered: string[] = [];
  for (const filePath of filePaths) {
    const kind = detectManifestKind(filePath);
    if (kind) {
      const norm = normalizePath(filePath);
      graph.addFile(norm, kind);
      registered.push(norm);
    }
  }
  return registered;
}
