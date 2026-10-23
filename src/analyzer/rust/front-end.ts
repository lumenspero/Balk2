/**
 * The Rust front end. It parses each Rust file and writes its named items to the graph as symbols,
 * the same way the Python front end does (9.1). It then binds the `use` declarations of each Cargo
 * crate and writes the `imports` edges they give (9.3). Calls and references come in later
 * sub-phases (9.6, 9.7).
 */
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
import { computeExports } from './names/exports.js';
import { bindImports } from './names/imports.js';
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
    for (const { index: crate, exporting } of crates) {
      if (exporting) {
        for (const edge of computeExports(crate)) {
          graph.addRelationship('exports', edge.from, edge.id, 'high', {
            evidence: 'ast',
            metadata: { visibility: 'public' },
          });
        }
      }
      const result = bindImports(crate, env);
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
    return { problems: [], syntaxErrors };
  }
}

/**
 * One crate index per Cargo crate root, and the names of the crates a path can reach: the Phase 7
 * extern table, and the library targets of the repository's packages by their code name.
 */
function buildCrates(
  input: FrontEndInput,
  rustFiles: ReadonlySet<string>,
): { crates: { index: RustCrateIndex; exporting: boolean }[]; env: RustNameEnvironment } {
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
  const crates: { index: RustCrateIndex; exporting: boolean }[] = [];
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
    crates.push({ index, exporting: target === 'lib' || target === 'proc-macro' });
    indexByPackage.set(root.packageId, index);
  }
  for (const node of packages.packages) {
    if (node.ecosystem !== 'cargo' || node.target !== 'lib') continue;
    const index = indexByPackage.get(node.id);
    if (index !== undefined && !repoCrates.has(node.name)) repoCrates.set(node.name, index);
  }
  return { crates, env };
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
