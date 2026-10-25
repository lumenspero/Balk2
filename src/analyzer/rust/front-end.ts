/**
 * The Rust front end. It parses each Rust file and writes its named items to the graph as symbols,
 * the same way the Python front end does (9.1). It then binds the `use` declarations of each Cargo
 * crate and writes the `imports` edges they give (9.3). Calls and references come in later
 * sub-phases (9.6, 9.7).
 */
import { applyDataEdges } from '../../data/data-analyzer.js';
import { runDataEngine } from '../../facts/data-engine.js';
import { defaultBareBases } from '../../facts/path-value.js';
import { pathBaseOrder } from '../../config/path-base-config.js';
import { analyzeRustDataApis, type RustConstant, type RustConstantLookup } from './data-apis.js';
import type { ModulePosition } from './data-apis.js';

/** Longest chain of `pub use` re-exports followed to a constant, which stops cycles. */
const MAX_REEXPORTS = 8;
import { RustModuleTree } from './module-tree.js';
import * as fs from 'fs';
import * as path from 'path';
import type { ConnectionGraph } from '../../graph.js';
import { normalizePath } from '../../graph.js';
import type { SourceSpan } from '../../types.js';
import type {
  FrontEndInput,
  FrontEndLanguage,
  FrontEndResult,
  LanguageFrontEnd,
} from '../front-end.js';
import type { SyntaxErrorNote } from '../repository-program.js';
import type { Span } from './items.js';
import { parseRustFile } from './items.js';
import { bindCalls } from './names/calls.js';
import { bindBuildScripts } from './names/build-scripts.js';
import { bindIncludes } from './names/includes.js';
import { collectRustSourceAnnotations } from './source-annotations-apply.js';
import { bindProcMacros } from './names/proc-macros.js';
import { attributeRegistrations } from './names/attribute-registrations.js';
import { rustRegistryFacts } from './names/registry-facts.js';
import { rustStateFacts } from './names/state-facts.js';
import {
  RUST_CALLBACK_CATALOG,
  rustCallbackFacts,
  rustCallbackFiles,
} from './names/callback-facts.js';
import { applyCallbackEdges } from '../callback-apply.js';
import { nativeLoadObservations } from './names/native-loads.js';
import { runCallbackEngine } from '../../facts/callback-engine.js';
import { applyStateEdges } from '../state-apply.js';
import { runStateEngine, statePathFiles } from '../../facts/state-engine.js';
import { applyRegistryEdges } from '../registry-apply.js';
import { runRegistryEngine } from '../../facts/registry-engine.js';
import { bindReferences } from './names/references.js';
import { computeExports } from './names/exports.js';
import { bindImports, type ImportResult } from './names/imports.js';
import { bindTypeRelations } from './names/type-relations.js';
import { buildCrateIndex, type RustCrateIndex } from './names/module-index.js';
import type { RustNameEnvironment } from './names/resolve.js';
import { analyzeRustSymbols } from './symbols.js';

function isRustPath(filePath: string): boolean {
  return normalizePath(filePath).toLowerCase().endsWith('.rs');
}

export class RustFrontEnd implements LanguageFrontEnd {
  readonly name = 'RustFrontEnd';
  readonly languages: readonly FrontEndLanguage[] = ['rust'];

  canHandle(filePath: string): boolean {
    return isRustPath(filePath);
  }

  analyze(input: FrontEndInput, graph: ConnectionGraph): FrontEndResult {
    const syntaxErrors: SyntaxErrorNote[] = [];
    const rustFiles = new Set<string>();
    const sources = new Map<string, string>();
    for (const relFile of input.files) {
      const filePath = normalizePath(relFile);
      if (!this.canHandle(filePath)) continue;
      let source: string;
      try {
        source = fs.readFileSync(path.join(input.rootDir, relFile), 'utf8');
      } catch {
        // Skip unreadable files, as the other front ends do.
        continue;
      }
      rustFiles.add(filePath);
      sources.set(filePath, source);
      // The parser recovers past each error, so every file is still analyzed.
      const file = parseRustFile(source);
      for (const e of file.errors) {
        syntaxErrors.push({ path: filePath, line: e.line, column: e.column, message: e.message });
      }
      graph.addFile(filePath, 'rust');
      for (const declaration of analyzeRustSymbols(file, filePath).declarations) {
        graph.addSymbol(filePath, declaration.name, declaration.symbolType);
      }
    }

    const { crates, env } = buildCrates(input, rustFiles);
    // `#[no_mangle]` functions with an ABI carry it on their exports edge (9.7). Symbol nodes have no metadata.
    const abiById = new Map<string, string>();
    for (const { index } of crates) {
      for (const fn of index.functions) {
        if (fn.noMangle && fn.abi !== null) abiById.set(fn.id, fn.abi.replace(/^"|"$/g, ''));
      }
    }
    const bound = bindAllImports(crates, env);
    for (const { index: crate, exporting } of crates) {
      if (exporting) {
        for (const edge of computeExports(crate)) {
          const abi = abiById.get(edge.id);
          graph.addRelationship('exports', edge.from, edge.id, 'high', {
            evidence: 'ast',
            metadata: {
              visibility: crate.visibility.get(edge.id) ?? 'public',
              ...(abi === undefined ? {} : { abi }),
            },
          });
        }
      }
      const result = bound.get(crate) ?? { edges: [], unresolved: [] };
      for (const edge of result.edges) {
        graph.addRelationship('imports', edge.file, edge.target, 'high', {
          evidence: 'ast',
          spans: [toSourceSpan(edge.span, edge.file)],
        });
      }
      for (const use of result.unresolved) {
        const location = toSourceSpan(use.span, use.file);
        const unresolved = graph.addUnresolved({
          reason: use.reason,
          attempted: 'imports',
          subject: use.subject,
          location,
          detail: use.detail,
        });
        graph.addRelationship('imports', use.file, unresolved.id, 'low', {
          evidence: 'ast',
          spans: [location],
        });
      }
      const relations = bindTypeRelations(crate, env);
      for (const edge of relations.edges) {
        graph.addRelationship(edge.kind, edge.from, edge.to, 'high', {
          evidence: 'ast',
          spans: [toSourceSpan(edge.span, edge.file)],
        });
      }
      for (const observation of relations.unresolved) {
        const location = toSourceSpan(observation.span, observation.file);
        const unresolved = graph.addUnresolved({
          reason: observation.reason,
          attempted: observation.kind,
          subject: observation.subject,
          location,
          detail: observation.detail,
        });
        graph.addRelationship(observation.kind, observation.file, unresolved.id, 'low', {
          evidence: 'ast',
          spans: [location],
        });
      }
    }

    // Calls bind after every crate is indexed, so an impl in one crate can serve a call in another.
    const calls = bindCalls(
      crates.map((c) => c.index),
      env,
    );
    for (const edge of calls.edges) {
      graph.addRelationship('calls', edge.from, edge.to, edge.confidence, {
        evidence: 'ast',
        spans: edge.spans.map((span) => toSourceSpan(span, edge.file)),
        ...(edge.dispatch ? { metadata: { dispatch: 'trait' } } : {}),
      });
    }
    for (const call of calls.unresolved) {
      const location = toSourceSpan(call.span, call.file);
      const unresolved = graph.addUnresolved({
        reason: call.reason,
        attempted: 'calls',
        subject: call.subject,
        location,
        detail: call.detail,
      });
      graph.addRelationship('calls', call.file, unresolved.id, 'low', {
        evidence: 'ast',
        spans: [location],
      });
    }
    // Build scripts (10.5): the package of each build script, by manifest, for OUT_DIR includes.
    const manifestById = new Map(
      (input.packages?.packages ?? []).map((node) => [node.id, node.manifest]),
    );
    const buildScriptByManifest = new Map<string, string>();
    for (const node of input.packages?.packages ?? []) {
      if (node.ecosystem === 'cargo' && node.target === 'build-script') {
        buildScriptByManifest.set(node.manifest, node.id);
      }
    }
    const buildScriptOf = new Map<string, string>();
    for (const crate of crates) {
      const manifest = manifestById.get(crate.id);
      const script = manifest === undefined ? undefined : buildScriptByManifest.get(manifest);
      if (script !== undefined) buildScriptOf.set(crate.id, script);
    }

    // Build scripts (10.5): cargo:rerun-if-changed lines name the files a build script reads.
    const buildScriptEdges = bindBuildScripts(
      crates.map((c) => ({ index: c.index, packageDir: c.packageDir, buildScript: c.buildScript })),
      new Set(input.files.map(normalizePath)),
    );
    for (const edge of buildScriptEdges) {
      if (edge.kind === 'reads') {
        if (!graph.hasArtifact(edge.artifactPath))
          graph.addArtifact(edge.artifactPath, edge.format);
        graph.addRelationship('reads', edge.from, edge.artifactPath, 'high', {
          evidence: 'ast',
          spans: [toSourceSpan(edge.span, edge.file)],
          metadata: { mechanism: 'build-script' },
        });
      } else {
        const location = toSourceSpan(edge.span, edge.file);
        const unresolved = graph.addUnresolved({
          reason: edge.reason,
          attempted: 'reads',
          subject: edge.subject,
          location,
          detail: edge.detail,
        });
        graph.addRelationship('reads', edge.from, unresolved.id, 'low', {
          evidence: 'ast',
          spans: [location],
        });
      }
    }

    // Compile-time includes (10.4): include!, include_str! and include_bytes! link the files they name.
    const includes = bindIncludes(
      crates.map((c) => ({ index: c.index, packageDir: c.packageDir, packageId: c.id })),
      new Set(input.files.map(normalizePath)),
    );
    for (const edge of includes) {
      if (edge.kind === 'imports') {
        graph.addRelationship('imports', edge.from, edge.to, 'high', {
          evidence: 'ast',
          spans: [toSourceSpan(edge.span, edge.file)],
          metadata: { loadKind: 'include-macro' },
        });
      } else if (edge.kind === 'uses') {
        const node = graph.addResource(edge.resourcePath, edge.resourceKind);
        graph.addRelationship('usesResource', edge.from, node.id, 'high', {
          evidence: 'ast',
          spans: [toSourceSpan(edge.span, edge.file)],
          metadata: { resourceKind: edge.resourceKind, mechanism: 'include' },
        });
      } else if (edge.kind === 'consumes') {
        if (!graph.hasArtifact(edge.artifactPath))
          graph.addArtifact(edge.artifactPath, edge.format);
        graph.addRelationship('consumes', edge.from, edge.artifactPath, 'high', {
          evidence: 'ast',
          spans: [toSourceSpan(edge.span, edge.file)],
          metadata: { embed: true },
        });
      } else if (edge.kind === 'build-output') {
        // An OUT_DIR file is written by the package's build script (10.5), when it has one.
        const buildScript = buildScriptOf.get(edge.from);
        if (buildScript !== undefined) {
          graph.addRelationship('dependsOn', edge.from, buildScript, 'medium', {
            evidence: 'ast',
            spans: [toSourceSpan(edge.span, edge.file)],
            metadata: { kind: 'build-output' },
          });
        } else {
          const location = toSourceSpan(edge.span, edge.file);
          const unresolved = graph.addUnresolved({
            reason: 'dynamic-include-path',
            attempted: 'imports',
            subject: edge.subject,
            location,
            detail: 'OUT_DIR names a build output, and the package has no build script',
          });
          graph.addRelationship('imports', edge.file, unresolved.id, 'low', {
            evidence: 'ast',
            spans: [location],
          });
        }
      } else {
        const location = toSourceSpan(edge.span, edge.file);
        const unresolved = graph.addUnresolved({
          reason: edge.reason,
          attempted: edge.attempted,
          subject: edge.subject,
          location,
          detail: edge.detail,
        });
        graph.addRelationship(edge.attempted, edge.from, unresolved.id, 'low', {
          evidence: 'ast',
          spans: [location],
        });
      }
    }

    // Proc macros (10.3): a derive or attribute links its item to the proc macro that provides it.
    const procMacros = bindProcMacros(
      crates.map((c) => ({ id: c.id, index: c.index, procMacro: c.procMacro })),
      (input.packages?.dependencies ?? []).map((d) => ({ from: d.from, to: d.to })),
    );
    for (const edge of procMacros) {
      graph.addRelationship('references', edge.from, edge.to, 'high', {
        evidence: 'ast',
        spans: [toSourceSpan(edge.span, edge.file)],
        metadata: { mechanism: edge.mechanism },
      });
    }
    // Attribute registrations (12.2): an attribute named in `protocols.registries.attributes` declares its item.
    applyRegistryEdges(
      graph,
      runRegistryEngine({
        configured: [],
        facts: attributeRegistrations(
          crates.map((c) => ({ index: c.index })),
          input.config?.protocols?.registries?.attributes ?? [],
        ),
      }),
    );
    // Local maps, statics and configured bare calls as registries (12.2).
    applyRegistryEdges(
      graph,
      runRegistryEngine({
        configured: [],
        facts: rustRegistryFacts(
          crates.map((c) => c.index),
          env,
          input.config?.protocols?.registries?.methods ?? [],
        ),
      }),
    );
    // Callbacks passed to `thread::spawn` or an iterator method (Phase 12.4).
    applyCallbackEdges(
      graph,
      runCallbackEngine({
        files: rustCallbackFiles(
          rustCallbackFacts(
            crates.map((c) => c.index),
            env,
          ),
        ),
        catalog: RUST_CALLBACK_CATALOG,
      }),
    );
    // Native library loads (12.5): `libloading::Library::new` is an observation, since the library's
    // code is not analyzed. Each is a low-confidence link from the function that loads it.
    for (const load of nativeLoadObservations(
      crates.map((c) => c.index),
      env,
    )) {
      const unresolved = graph.addUnresolved({
        reason: load.reason,
        attempted: 'imports',
        subject: load.subject,
        location: load.location,
        detail: load.detail,
      });
      graph.addRelationship('imports', load.from, unresolved.id, 'low', {
        evidence: 'ast',
        spans: [load.location],
        metadata: { mechanism: 'native-library' },
      });
    }
    // Shared state (Phase 12.3): writes to a `static mut`.
    applyStateEdges(
      graph,
      runStateEngine({
        files: statePathFiles(
          rustStateFacts(
            crates.map((c) => c.index),
            env,
            input.config?.state?.singletons ?? [],
          ),
          'rust',
        ),
        dynamicPaths: 'off',
      }),
    );
    const references = bindReferences(
      crates.map((c) => c.index),
      env,
    );
    for (const edge of references.edges) {
      graph.addRelationship('references', edge.from, edge.to, 'high', {
        evidence: 'ast',
        spans: edge.spans.map((span) => toSourceSpan(span, edge.file)),
      });
    }
    for (const mention of references.unresolved) {
      const location = toSourceSpan(mention.span, mention.file);
      const unresolved = graph.addUnresolved({
        reason: mention.reason,
        attempted: 'references',
        subject: mention.subject,
        location,
        detail: mention.detail,
      });
      graph.addRelationship('references', mention.file, unresolved.id, 'low', {
        evidence: 'ast',
        spans: [location],
      });
    }
    // Data lineage (Phase 11.3, with constants in 11.6): catalog calls with a path. A `use crate::`
    // path to a constant in another file is followed to that file, which is where the path is
    // placed from. A bare path is placed from that directory's package, then the repository root (11.4).
    const knownFiles = new Set(input.files.map(normalizePath));
    const modules = new RustModuleTree({
      files: [...sources.keys()],
      exists: (file): boolean => knownFiles.has(file),
      source: (file): string | undefined => sources.get(file),
      crateRoot: (file): string | undefined => crateRootOf(file, knownFiles),
    });
    // A constant a `pub use` re-exports is followed to the module that declares it (Phase 11.5).
    const constantOf = (
      from: ModulePosition,
      path: readonly string[],
      depth: number,
    ): RustConstant | undefined => {
      const name = path[path.length - 1];
      if (name === undefined || depth > MAX_REEXPORTS) return undefined;
      const module = modules.resolve(path.slice(0, -1), from);
      if (module === undefined) return undefined;
      const value = modules.constantAt(module, name);
      if (value !== undefined) return { value, declaringFile: module.file };
      const reexport = modules.reexportAt(module, name);
      return reexport === undefined ? undefined : constantOf(module, reexport, depth + 1);
    };
    const lookup: RustConstantLookup = (from, path) => constantOf(from, path, 0);
    const dataFacts = [...sources].flatMap(([filePath, source]) =>
      analyzeRustDataApis(filePath, source, lookup),
    );
    applyDataEdges(
      graph,
      runDataEngine({
        facts: dataFacts,
        paths: {
          exists: (repoPath) => knownFiles.has(repoPath),
          bases: (fact) => {
            const placedFrom = fact.pathFilePath ?? fact.filePath;
            const packageDir = nearestPackageDir(placedFrom, knownFiles);
            return defaultBareBases(
              'rust',
              {
                file: dirOf(placedFrom),
                ...(packageDir === undefined ? {} : { package: packageDir }),
              },
              pathBaseOrder(input.config, 'rust'),
            );
          },
        },
      }),
    );
    // Source directives in comments (12.7), owned by the function that holds each statement.
    return {
      problems: [],
      syntaxErrors,
      sourceAnnotations: collectRustSourceAnnotations(
        sources,
        crates.flatMap(({ index }) => index.functions),
      ),
    };
  }
}

/** The crate root file of a file's crate: `src/lib.rs` or `src/main.rs`, or undefined (Phase 11.6). */
function crateRootOf(filePath: string, knownFiles: ReadonlySet<string>): string | undefined {
  const packageDir = nearestPackageDir(filePath, knownFiles);
  if (packageDir === undefined) return undefined;
  const base = packageDir === '' ? 'src' : `${packageDir}/src`;
  return [`${base}/lib.rs`, `${base}/main.rs`].find((candidate) => knownFiles.has(candidate));
}

/** The directory of a repository path, or '' for a file at the root. */
function dirOf(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  return slash < 0 ? '' : filePath.slice(0, slash);
}

/** The nearest directory at or above a file that holds a `Cargo.toml`, or undefined if none. */
function nearestPackageDir(filePath: string, knownFiles: ReadonlySet<string>): string | undefined {
  let dir = dirOf(filePath);
  for (;;) {
    if (knownFiles.has(dir === '' ? 'Cargo.toml' : `${dir}/Cargo.toml`)) return dir;
    if (dir === '') return undefined;
    dir = dirOf(dir);
  }
}

/** A crate of the repository: its index, its target id and whether it is a proc-macro crate. */
interface CrateEntry {
  readonly index: RustCrateIndex;
  readonly exporting: boolean;
  readonly id: string;
  readonly procMacro: boolean;
  /** Repository-relative directory of the package, for `CARGO_MANIFEST_DIR` (10.4). */
  readonly packageDir: string | undefined;
  /** True for a build script target (10.5). */
  readonly buildScript: boolean;
}

/**
 * One crate index per Cargo crate root, and the names of the crates a path can reach: the Phase 7
 * extern table, and the library targets of the repository's packages by their code name.
 */
function buildCrates(
  input: FrontEndInput,
  rustFiles: ReadonlySet<string>,
): { crates: CrateEntry[]; env: RustNameEnvironment } {
  const externs = new Set<string>();
  const repoCrates = new Map<string, RustCrateIndex>();
  const env: RustNameEnvironment = { externs, repoCrates };
  const packages = input.packages;
  if (packages === undefined) return { crates: [], env };

  for (const extern of packages.externs) externs.add(extern.name);
  const readText = (file: string): string => {
    try {
      return fs.readFileSync(path.join(input.rootDir, file), 'utf8');
    } catch {
      return '';
    }
  };
  const packageById = new Map(packages.packages.map((node) => [node.id, node]));
  const indexByPackage = new Map<string, RustCrateIndex>();
  const crates: CrateEntry[] = [];
  for (const root of packages.packageRoots) {
    if (!root.packageId.startsWith('package:cargo:')) continue;
    const file = normalizePath(root.file);
    if (!rustFiles.has(file)) continue;
    const index = buildCrateIndex({
      root: file,
      files: rustFiles,
      readText,
      edition: packageById.get(root.packageId)?.edition ?? '2021',
    });
    const target = packageById.get(root.packageId)?.target;
    crates.push({
      index,
      exporting: target === 'lib' || target === 'proc-macro',
      id: root.packageId,
      procMacro: target === 'proc-macro',
      packageDir: packageDirOf(packageById.get(root.packageId)?.manifest),
      buildScript: target === 'build-script',
    });
    indexByPackage.set(root.packageId, index);
  }
  // A proc-macro package is a library that exports macros, so a `use` of it resolves like a library.
  for (const node of packages.packages) {
    if (node.ecosystem !== 'cargo' || (node.target !== 'lib' && node.target !== 'proc-macro'))
      continue;
    const index = indexByPackage.get(node.id);
    if (index !== undefined && !repoCrates.has(node.name)) repoCrates.set(node.name, index);
  }
  return { crates, env };
}

/** The most sweeps that bind all crates before giving up on a fixed point. */
const MAX_BINDING_SWEEPS = 8;

/**
 * Binds every crate's `use` declarations until a sweep changes no crate's result. A use may name a name
 * another crate's use brings in, and the crates are not in dependency order, so one sweep is not enough
 * (V3 Phase 9.9). Each crate's result is from the last sweep, which is the settled one.
 */
function bindAllImports(
  crates: readonly CrateEntry[],
  env: RustNameEnvironment,
): Map<RustCrateIndex, ImportResult> {
  const results = new Map<RustCrateIndex, ImportResult>();
  let previous = '';
  for (let sweep = 0; sweep < MAX_BINDING_SWEEPS; sweep++) {
    for (const { index } of crates) results.set(index, bindImports(index, env));
    const signature = JSON.stringify(
      crates.map(({ index }) => {
        const result = results.get(index);
        return [
          result?.edges.map((edge) => [edge.file, edge.target]),
          result?.unresolved.map((use) => [use.subject, use.reason]),
        ];
      }),
    );
    if (signature === previous) break;
    previous = signature;
  }
  return results;
}

/** The repository-relative directory holding a package's manifest, or undefined when unknown. */
function packageDirOf(manifest: string | undefined): string | undefined {
  if (manifest === undefined) return undefined;
  const dir = path.posix.dirname(manifest);
  return dir === '.' ? '' : dir;
}

function toSourceSpan(span: Span, filePath: string): SourceSpan {
  return {
    filePath,
    startLine: span.line,
    startColumn: span.column,
    endLine: span.endLine,
    endColumn: span.endColumn,
  };
}
