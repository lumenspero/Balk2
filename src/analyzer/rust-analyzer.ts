import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ConnectionGraph } from '../graph.js';
import { normalizePath } from '../graph.js';
import { discoverRepositoryPackages } from '../packages/repository-packages.js';
import { buildModuleTree } from './rust/modules/tree.js';
import { RustFrontEnd } from './rust/front-end.js';
import type { Analyzer, AnalyzerOptions } from './types.js';

/**
 * Compatibility wrapper for the Rust front end (V3 Phase 16.5, per the Phase 0 contract). The
 * Rust front end reads a whole crate from disk, so `analyzeFile` stages the file's content and the
 * other known files it can read under `options.rootDir` into a temporary root, then analyzes that.
 * Package and module-tree edges are added as the repository pipeline adds them; its diagnostics are not.
 * A crate's module files and its `Cargo.toml` are only seen when they are listed in
 * `options.knownFiles`. Without them, a `mod` declaration or a dependency is not found.
 *
 * For a repository, use `generateConnectionMap`, which the CLI also uses.
 *
 * @deprecated Use `generateConnectionMap` for a repository. `analyzeFile` remains for single files.
 */
export class RustAnalyzer implements Analyzer {
  readonly name = 'RustAnalyzer';
  readonly supportedExtensions: readonly string[] = ['.rs'];

  canAnalyze(filePath: string): boolean {
    return normalizePath(filePath).toLowerCase().endsWith('.rs');
  }

  analyzeFile(
    filePath: string,
    content: string,
    graph: ConnectionGraph,
    options?: AnalyzerOptions,
  ): void {
    const normalizedPath = normalizePath(filePath);
    const files = new Set<string>([normalizedPath]);
    for (const known of options?.knownFiles ? Array.from(options.knownFiles) : []) {
      files.add(normalizePath(known));
    }

    const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-rust-analyzer-'));
    try {
      for (const rel of files) {
        const target = path.join(staged, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (rel === normalizedPath) {
          fs.writeFileSync(target, content, 'utf8');
          continue;
        }
        const source = options?.rootDir
          ? readOrUndefined(path.join(options.rootDir, rel))
          : undefined;
        if (source !== undefined) fs.writeFileSync(target, source, 'utf8');
        else files.delete(rel);
      }
      const readStaged = (rel: string): string => fs.readFileSync(path.join(staged, rel), 'utf8');
      const packages = discoverRepositoryPackages([...files], readStaged, (rel) =>
        fs.existsSync(path.join(staged, rel)),
      );
      // The same package and module-tree facts build-graph adds before the front ends run.
      for (const node of packages.packages) graph.addPackage(node);
      for (const root of packages.packageRoots) {
        graph.addRelationship('packageRoot', root.packageId, root.file, 'high', {
          evidence: 'manifest',
        });
      }
      for (const dependency of packages.dependencies) {
        graph.addRelationship('dependsOn', dependency.from, dependency.to, 'high', {
          evidence: 'manifest',
          metadata: dependency.metadata,
        });
      }
      const cargoDirs = packages.packages
        .filter((node) => node.id.startsWith('package:cargo:'))
        .map((node) => node.id.slice('package:cargo:'.length).split('#')[0] ?? '.');
      const moduleTree = buildModuleTree({
        crateRoots: packages.packageRoots
          .filter((root) => root.packageId.startsWith('package:cargo:'))
          .map((root) => root.file),
        packageDirs: cargoDirs,
        files,
        readText: readStaged,
      });
      for (const file of moduleTree.files) graph.addFile(file, 'rust');
      for (const edge of moduleTree.edges) {
        graph.addRelationship('declaresModule', edge.from, edge.to, 'high', {
          evidence: 'ast',
          ...(edge.cfg ? { metadata: { cfg: edge.cfg } } : {}),
        });
      }
      new RustFrontEnd().analyze({ rootDir: staged, files: [...files], packages }, graph);
    } finally {
      fs.rmSync(staged, { recursive: true, force: true });
    }
  }
}

function readOrUndefined(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}
