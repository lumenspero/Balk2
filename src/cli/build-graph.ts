import * as fs from 'fs';
import * as path from 'path';
import { ConnectionGraph, normalizePath } from '../graph.js';
import { applyAnnotations, type Annotation } from '../analyzer/annotations.js';
import type { FrontEndInput, FrontEndSourceAnnotations } from '../analyzer/front-end.js';
import { JsTsFrontEnd } from '../analyzer/js-ts-front-end.js';
import { PythonFrontEnd } from '../analyzer/python-front-end.js';
import { registerDataArtifacts } from '../data/formats.js';
import { registerManifests } from '../data/manifests.js';
import { filterFilesWithConfig, applyExplicitLineage } from '../config/index.js';
import type { Balk2Config } from '../config/balk2-config.js';
import type { ConfigProblem } from '../config/config-problem.js';
import type { SyntaxErrorNote } from '../analyzer/repository-program.js';
import { discoverRepositoryPackages } from '../packages/repository-packages.js';
import { buildModuleTree, type ModuleTree } from '../analyzer/rust/modules/tree.js';
import type { ModuleProblemInput } from './diagnostics.js';

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

/** Dependency-resolution lock files. They describe resolved versions, not source, so they are not scanned. */
const LOCK_FILES = new Set([
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'pdm.lock',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
]);

/** Tool caches and build output that are excluded by name, wherever they appear. */
const GENERATED_DIR_NAMES = new Set([
  '__pycache__',
  '.tox',
  '.nox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
]);

/** The graph, and what the analysis dropped that the configuration asked for. */
export interface BuiltGraph {
  readonly graph: ConnectionGraph;
  /** Configured entries the analysis could not use, such as a singleton with no export */
  readonly problems: readonly ConfigProblem[];
  /** Syntax errors in analyzed source files. The graph is still built from the recovered trees. */
  readonly syntaxErrors: readonly SyntaxErrorNote[];
  /** Manifests that cannot be read or resolved, reported as `manifest` diagnostics */
  readonly manifestProblems: readonly { readonly path: string; readonly message: string }[];
  /** Rust module conflicts and unreachable files, reported as `module-conflict` and `unreachable-module` */
  readonly moduleProblems: readonly ModuleProblemInput[];
  /** The Rust module tree: per-crate edges and files, for the rustc oracle (V3 Phase 8.5) */
  readonly moduleTree: ModuleTree;
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

  // 2. Package discovery. Cargo, npm and Python manifests yield package nodes, `packageRoot` edges
  //    for Cargo and npm targets, and `dependsOn` edges. The Python front end adds its entry points.
  const repositoryPackages = discoverRepositoryPackages(
    files,
    (filePath) => fs.readFileSync(path.join(rootDir, filePath), 'utf8'),
    (filePath) => fs.existsSync(path.join(rootDir, filePath)),
  );
  for (const node of repositoryPackages.packages) graph.addPackage(node);
  for (const root of repositoryPackages.packageRoots) {
    graph.addRelationship('packageRoot', root.packageId, root.file, 'high', {
      evidence: 'manifest',
    });
  }
  for (const dependency of repositoryPackages.dependencies) {
    graph.addRelationship('dependsOn', dependency.from, dependency.to, 'high', {
      evidence: 'manifest',
      metadata: dependency.metadata,
    });
  }

  // Rust module tree (V3 Phase 8.3, 8.4): `mod` declarations from each Cargo crate root become
  // declaresModule edges. Declarations that cannot be connected become unresolved references, and
  // conflicts and unreachable files become diagnostics.
  const cargoPackages = repositoryPackages.packages.filter((node) =>
    node.id.startsWith('package:cargo:'),
  );
  const moduleTree = buildModuleTree({
    crateRoots: repositoryPackages.packageRoots
      .filter((root) => root.packageId.startsWith('package:cargo:'))
      .map((root) => root.file),
    packageDirs: cargoPackages.map(
      (node) => node.id.slice('package:cargo:'.length).split('#')[0] ?? '.',
    ),
    files: new Set(files),
    readText: (filePath) => fs.readFileSync(path.join(rootDir, filePath), 'utf8'),
  });
  for (const file of moduleTree.files) graph.addFile(file, 'rust');
  for (const edge of moduleTree.edges) {
    graph.addRelationship('declaresModule', edge.from, edge.to, 'high', {
      evidence: 'ast',
      ...(edge.cfg ? { metadata: { cfg: edge.cfg } } : {}),
    });
  }
  for (const module of moduleTree.unresolved) {
    const unresolved = graph.addUnresolved({
      reason: 'unresolved-module-path',
      attempted: 'declaresModule',
      subject: module.subject,
      location: module.location,
      detail: module.detail,
    });
    graph.addRelationship('declaresModule', module.file, unresolved.id, 'low', {
      evidence: 'ast',
      spans: [module.location],
    });
  }
  const moduleProblems: ModuleProblemInput[] = [
    ...moduleTree.conflicts.map((conflict) => ({
      kind: 'module-conflict' as const,
      path: conflict.file,
      line: conflict.location.startLine,
      column: conflict.location.startColumn,
      message: conflict.message,
    })),
    ...moduleTree.unreachable.map((file) => ({
      kind: 'unreachable-module' as const,
      path: file,
      message: 'no crate root reaches this file',
    })),
  ];

  // 3. Front ends, in a fixed order: JS/TS, then Python. Data artifacts are registered first so
  //    the front ends see them.
  registerDataArtifacts(files, graph);
  registerManifests(files, graph);
  const input: FrontEndInput = { rootDir, files, config, packages: repositoryPackages };
  const jsTsResult = new JsTsFrontEnd().analyze(input, graph);
  const pythonResult = new PythonFrontEnd().analyze(input, graph);
  problems.push(...jsTsResult.problems, ...pythonResult.problems);
  const manifestProblems = [
    ...repositoryPackages.problems,
    ...(pythonResult.manifestProblems ?? []),
  ];
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

  return { graph, problems, syntaxErrors, manifestProblems, moduleProblems, moduleTree };
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

/**
 * Whether a directory is excluded from the scan. `parentDir` is the directory that contains it.
 *
 * - `target/` is a Cargo build directory only beside a `Cargo.toml`.
 * - `.venv/` and `venv/` are virtual environments only when they contain `pyvenv.cfg`.
 * - `build/lib*` is already covered, because `build` is excluded by name.
 */
function isExcludedDirectory(parentDir: string, name: string, fullPath: string): boolean {
  if (DEFAULT_EXCLUDES.has(name) || GENERATED_DIR_NAMES.has(name)) return true;
  if (name.endsWith('.egg-info')) return true;
  if (name === 'target') return fs.existsSync(path.join(parentDir, 'Cargo.toml'));
  if (name === '.venv' || name === 'venv') return fs.existsSync(path.join(fullPath, 'pyvenv.cfg'));
  return false;
}

/** Recursively list repository-relative files, sorted, skipping excluded directories and locks. */
export function scanRepositoryFiles(dir: string, baseDir: string = dir): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const relPath = normalizePath(path.relative(baseDir, fullPath));

    if (entry.isDirectory()) {
      if (isExcludedDirectory(dir, entry.name, fullPath)) continue;
      results.push(...scanRepositoryFiles(fullPath, baseDir));
    } else if (entry.isFile()) {
      if (DEFAULT_EXCLUDES.has(entry.name) || LOCK_FILES.has(entry.name)) continue;
      results.push(relPath);
    }
  }

  return results.sort();
}
