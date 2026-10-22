/**
 * The Python front end (V3 Phase 5.7b and 5.7c). It runs the fact passes over a set of Python files
 * and writes their graph entries: files, symbols, exports, imports, `extends`, `implements`,
 * `calls` and `references`. Every fact-derived edge carries `evidence: 'ast'` and its spans.
 *
 * The non-fact mechanisms still run through python-mechanisms.ts (data literals, importlib loads)
 * and python-source-apply.ts (source annotations). Phases 11 and 12 retire them.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ConnectionGraph } from '../graph.js';
import { normalizePath } from '../graph.js';
import type {
  FrontEndInput,
  FrontEndLanguage,
  FrontEndResult,
  LanguageFrontEnd,
} from './front-end.js';
import { addPythonMechanisms } from './python-mechanisms.js';
import { collectPythonSourceAnnotations } from './python-source-apply.js';
import { analyzePythonCalls } from './python/calls.js';
import { parseModuleRecovering } from './python/statement-parser.js';
import { createImportResolver } from './python/modules/import-resolution.js';
import { ModuleIndex } from './python/modules/module-index.js';
import { createSymbolResolver } from './python/modules/module-exports.js';
import { analyzeInheritance, toSourceSpan, type InheritanceFile } from './python/inheritance.js';
import { analyzePythonReferences } from './python/references.js';
import { analyzePythonSymbols } from './python/symbols.js';
import type { SyntaxErrorNote } from './repository-program.js';

function isPythonPath(filePath: string): boolean {
  return normalizePath(filePath).toLowerCase().endsWith('.py');
}

/**
 * Writes the graph entries of a set of Python files (V3 Phase 5.7c). `sources` are the files to
 * analyze. `knownFiles` are every repository file, which module resolution searches. `readText`
 * returns the text of any Python file, so an import can be resolved against its exports.
 */
/** Options for one pass over Python sources. */
export interface PythonSourceOptions {
  /** Import roots, repository-relative, in precedence order. Defaults to the repository root. */
  readonly roots?: readonly string[];
  /** Decorators that return their argument unchanged, from `python.identityDecorators`. */
  readonly identityDecorators?: readonly string[];
}

export function analyzePythonSources(
  sources: readonly InheritanceFile[],
  knownFiles: ReadonlySet<string>,
  readText: (filePath: string) => string,
  graph: ConnectionGraph,
  options: PythonSourceOptions = {},
): void {
  const modules = [...new Set([...knownFiles, ...sources.map((s) => s.filePath)])].filter(
    isPythonPath,
  );
  const index = new ModuleIndex(modules);
  const roots = options.roots?.length ? options.roots : ['.'];
  const imports = createImportResolver(index, { roots, readText });
  const symbols = createSymbolResolver({ resolver: imports, readText });
  const ctx = { symbols, imports };

  for (const { filePath } of sources) graph.addFile(filePath, 'python');

  // Imports: a repository file is an edge, with the statement's span as evidence.
  for (const { filePath, source } of sources) {
    for (const r of imports.resolveFile(filePath, source)) {
      if (r.target.kind !== 'file') continue;
      graph.addRelationship('imports', filePath, r.target.path, 'high', {
        evidence: 'ast',
        spans: [toSourceSpan(r.span, filePath)],
      });
    }
  }

  // Symbols and exports. A symbol's id is `file:qualified.name`, which `addSymbol` builds from
  // the name, so the qualified name is taken from the declaration id.
  for (const { filePath, source } of sources) {
    for (const d of analyzePythonSymbols(source, filePath).declarations) {
      graph.addSymbol(filePath, d.id.slice(filePath.length + 1), d.symbolType);
      if (d.exported) graph.addRelationship('exports', filePath, d.id);
    }
  }

  // Inheritance: `extends` to repository classes, and `implements` from `ABC.register`.
  const inheritance = analyzeInheritance(sources, ctx);
  for (const c of inheritance.classes) {
    for (const base of c.bases) {
      if (base.target?.kind !== 'symbol') continue;
      graph.addRelationship('extends', c.id, base.target.id, 'high', {
        evidence: 'ast',
        spans: [base.span],
      });
    }
  }
  for (const im of inheritance.implementations) {
    graph.addRelationship('implements', im.classId, im.abcId, 'high', {
      evidence: 'ast',
      spans: [im.span],
    });
  }

  // Calls. The owner is the enclosing function or method, or the file for module-level code.
  for (const c of analyzePythonCalls(sources, ctx, {
    identityDecorators: options.identityDecorators,
  }).calls) {
    if (c.callee.kind !== 'symbol') continue;
    graph.addRelationship('calls', c.owner ?? c.filePath, c.callee.id, c.confidence, {
      evidence: 'ast',
      spans: [c.span],
      ...(c.mechanism === undefined ? {} : { metadata: { mechanism: c.mechanism } }),
    });
  }

  // References: annotations, bases, isinstance targets, except classes and match classes.
  for (const r of analyzePythonReferences(sources, ctx).references) {
    if (r.target.kind !== 'symbol') continue;
    graph.addRelationship('references', r.owner ?? r.filePath, r.target.id, r.confidence, {
      evidence: 'ast',
      spans: [r.span],
    });
  }

  // Non-fact mechanisms, until Phases 11 and 12.
  for (const { filePath, source } of sources) {
    addPythonMechanisms(filePath, source, graph, knownFiles);
  }
}

export class PythonFrontEnd implements LanguageFrontEnd {
  readonly name = 'PythonFrontEnd';
  readonly languages: readonly FrontEndLanguage[] = ['python'];

  canHandle(filePath: string): boolean {
    return isPythonPath(filePath);
  }

  analyze(input: FrontEndInput, graph: ConnectionGraph): FrontEndResult {
    const sourceTexts: Record<string, string> = {};
    const files: InheritanceFile[] = [];
    const syntaxErrors: SyntaxErrorNote[] = [];
    for (const relFile of input.files) {
      const filePath = normalizePath(relFile);
      if (!this.canHandle(filePath)) continue;
      try {
        const source = fs.readFileSync(path.join(input.rootDir, relFile), 'utf8');
        sourceTexts[filePath] = source;
        files.push({ filePath, source });
        // The parser recovers past each error, so every file is still analyzed (3.3).
        for (const e of parseModuleRecovering(source).errors) {
          syntaxErrors.push({ path: filePath, line: e.line, column: e.column, message: e.message });
        }
      } catch {
        // Skip unreadable files, as the former per-file loop did.
      }
    }

    analyzePythonSources(
      files,
      new Set(input.files.map(normalizePath)),
      (p) => sourceTexts[p] ?? '',
      graph,
      {
        roots: input.config?.python?.roots,
        identityDecorators: input.config?.python?.identityDecorators,
      },
    );

    return {
      problems: [],
      syntaxErrors,
      sourceAnnotations: collectPythonSourceAnnotations(sourceTexts, []),
    };
  }
}
