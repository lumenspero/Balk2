import { posix } from 'path';
import * as ts from 'typescript';
import type { SourceSpan } from '../types.js';
import { normalizePath } from '../graph.js';
import type {
  BindingConsumer,
  BindingExport,
  BindingKind,
  FrontEndBindings,
} from './bindings/types.js';
import type { RepositoryProgram } from './repository-program.js';

/**
 * The JS/TS side of the wasm-bindgen bindings (V3 Phase 14.2). Every named export of a module is
 * a producer, which a Rust extern block with `module = "..."` can import. Every named import is a
 * consumer, which matches only a Rust export. Matching is by specifier, so a JS-to-JS import
 * never matches.
 */
/**
 * The binding kinds a JS/TS named import can consume. Each has a Rust producer; the index matches
 * a consumer only where its kind has one.
 */
const CONSUMER_KINDS: readonly BindingKind[] = ['wasm-bindgen', 'napi'];

export function jsTsBindings(repository: RepositoryProgram): FrontEndBindings {
  const exports: BindingExport[] = [];
  const consumers: BindingConsumer[] = [];
  for (const [rawFile, sourceFile] of repository.sourceFiles) {
    const file = normalizePath(rawFile);
    for (const statement of sourceFile.statements) {
      if (
        ts.isFunctionDeclaration(statement) &&
        statement.name !== undefined &&
        isExported(statement)
      ) {
        exports.push(exportOf(file, statement.name.text));
      } else if (ts.isVariableStatement(statement) && isExported(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name))
            exports.push(exportOf(file, declaration.name.text));
        }
      } else if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        const bindings = statement.importClause?.namedBindings;
        if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
        const specifier = resolveSpecifier(file, statement.moduleSpecifier.text);
        for (const element of bindings.elements) {
          for (const kind of CONSUMER_KINDS) {
            consumers.push({
              kind,
              side: 'javascript',
              specifier,
              name: (element.propertyName ?? element.name).text,
              file,
              span: spanOf(element, sourceFile, file),
            });
          }
        }
      }
    }
  }
  return { exports, consumers };
}

function exportOf(file: string, name: string): BindingExport {
  return {
    kind: 'wasm-bindgen',
    side: 'javascript',
    specifier: file,
    name,
    symbolId: `${file}:${name}`,
    file,
    confidence: 'high',
  };
}

/** A relative import names a file, and the module is `.js` even when written without it. */
function resolveSpecifier(file: string, specifier: string): string {
  if (!specifier.startsWith('.')) return specifier;
  const joined = posix.join(posix.dirname(file), specifier);
  return joined.endsWith('.js') ? joined : `${joined}.js`;
}

function isExported(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function spanOf(node: ts.Node, sourceFile: ts.SourceFile, file: string): SourceSpan {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    filePath: file,
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}
