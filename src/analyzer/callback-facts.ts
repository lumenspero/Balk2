import * as ts from 'typescript';
import type { ConnectionGraph } from '../graph.js';
import type { CallbackResolution } from '../facts/types.js';
import type { ArgValue, CallSite, FileFacts } from '../facts/types.js';
import type { CallbackProtocol } from './callback-protocols.js';
import { enclosingOwner } from './owner.js';
import type { RepositoryProgram } from './repository-program.js';
import { spanOf } from './spans.js';
import { unwrapExpression } from './static-keys.js';

/**
 * What an identifier refers to, as far as the callback pass can tell.
 *
 * - `external`: nothing in the repository declares it. Silent.
 * - `top-level`: a function or variable declared at the top level of a repository file, with a
 *   symbol in the graph.
 * - `other`: a parameter, a local, or a value with no symbol of its own. Reported as unresolved.
 */
type Reference =
  | { readonly kind: 'external' }
  | { readonly kind: 'top-level'; readonly id: string }
  | { readonly kind: 'other' };

/**
 * The TypeScript front end for callbacks. It finds calls to configured functions and classifies
 * the callback argument (`inline`, `symbol`, `external` or `unresolved`). The callback engine
 * decides what each classification means for the graph.
 */
export function extractCallbackFacts(
  repository: RepositoryProgram,
  graph: ConnectionGraph,
  callbacks: readonly CallbackProtocol[],
): FileFacts[] {
  const byName = new Map(callbacks.map((protocol) => [protocol.function, protocol] as const));
  const pathOf = new Map(
    [...repository.sourceFiles].map(([filePath, sourceFile]) => [sourceFile, filePath] as const),
  );

  const files: FileFacts[] = [];
  for (const [filePath, sourceFile] of sortedFiles(repository)) {
    if (sourceFile.isDeclarationFile) continue;

    const facts: CallSite[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const name = calleeName(node);
        const protocol = name !== undefined ? byName.get(name) : undefined;
        const argument = protocol ? node.arguments[protocol.callbackArg] : undefined;
        if (protocol !== undefined && name !== undefined && argument !== undefined) {
          const span = spanOf(argument, filePath);
          const resolution = resolveCallback(argument, sourceFile, repository, graph, pathOf);
          facts.push({
            kind: 'call',
            filePath,
            span: spanOf(node, filePath),
            owner: enclosingOwner(node, filePath),
            name,
            positional: Array.from({ length: node.arguments.length }, (_, index) =>
              index === protocol.callbackArg
                ? ({ kind: 'callback', span, resolution } satisfies ArgValue)
                : ({ kind: 'unknown' } satisfies ArgValue),
            ),
            keyword: {},
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    files.push({ filePath, language: languageOf(filePath), facts });
  }
  return files;
}

function resolveCallback(
  argument: ts.Expression,
  sourceFile: ts.SourceFile,
  repository: RepositoryProgram,
  graph: ConnectionGraph,
  pathOf: ReadonlyMap<ts.SourceFile, string>,
): CallbackResolution {
  const node = unwrapExpression(argument);
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return { kind: 'inline' };

  if (ts.isIdentifier(node)) {
    const reference = classify(node, repository, graph, pathOf);
    if (reference.kind === 'external') return { kind: 'external' };
    if (reference.kind === 'top-level') return { kind: 'symbol', id: reference.id };
    return { kind: 'unresolved', subject: node.getText(sourceFile) };
  }

  // Anything else (a call, a property access) is silent when it starts from an external module.
  const root = rootIdentifier(node);
  if (root !== undefined && classify(root, repository, graph, pathOf).kind === 'external') {
    return { kind: 'external' };
  }
  return { kind: 'unresolved', subject: node.getText(sourceFile) };
}

/** What an identifier refers to: external, a top-level symbol, or something else. */
function classify(
  identifier: ts.Identifier,
  repository: RepositoryProgram,
  graph: ConnectionGraph,
  pathOf: ReadonlyMap<ts.SourceFile, string>,
): Reference {
  const checker = repository.checker;
  let symbol = checker.getSymbolAtLocation(identifier);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!declaration) return { kind: 'external' };

  const declaringFile = declaration.getSourceFile();
  const filePath = pathOf.get(declaringFile);
  if (filePath === undefined || declaringFile.isDeclarationFile) return { kind: 'external' };

  const name = topLevelName(declaration);
  if (name !== undefined) {
    const id = `${filePath}:${name}`;
    if (graph.hasSymbol(id)) return { kind: 'top-level', id };
  }
  return { kind: 'other' };
}

/** The identifier at the start of a call or property chain (`lib` in `lib.make()`), if any. */
function rootIdentifier(expression: ts.Expression): ts.Identifier | undefined {
  let current: ts.Expression = unwrapExpression(expression);
  for (;;) {
    if (ts.isIdentifier(current)) return current;
    if (ts.isCallExpression(current) || ts.isPropertyAccessExpression(current)) {
      current = unwrapExpression(current.expression);
      continue;
    }
    return undefined;
  }
}

/** The name of a declaration that sits directly in its file, or undefined when it is nested. */
function topLevelName(declaration: ts.Declaration): string | undefined {
  if (ts.isFunctionDeclaration(declaration) && declaration.name) {
    return ts.isSourceFile(declaration.parent) ? declaration.name.text : undefined;
  }
  if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
    const list = declaration.parent;
    const statement = list?.parent;
    const isTopLevel =
      ts.isVariableDeclarationList(list) &&
      statement !== undefined &&
      ts.isVariableStatement(statement) &&
      ts.isSourceFile(statement.parent);
    return isTopLevel ? declaration.name.text : undefined;
  }
  return undefined;
}

/** `onReady(...)` gives `onReady`; `bus.onReady(...)` gives `onReady`. */
function calleeName(call: ts.CallExpression): string | undefined {
  const callee = unwrapExpression(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

function languageOf(filePath: string): FileFacts['language'] {
  return /\.(ts|tsx|mts|cts)$/.test(filePath) ? 'typescript' : 'javascript';
}

function sortedFiles(repository: RepositoryProgram): [string, ts.SourceFile][] {
  return [...repository.sourceFiles].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
