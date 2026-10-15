import * as ts from 'typescript';
import type { ConnectionGraph } from '../graph.js';
import type { CallbackProtocol } from './callback-protocols.js';
import { enclosingOwner } from './owner.js';
import type { RepositoryProgram } from './repository-program.js';
import { spanOf } from './spans.js';
import { unwrapExpression } from './static-keys.js';

/**
 * What an identifier refers to, as far as the callback pass can tell.
 *
 * - `external`: nothing in the repository declares it (a missing package, a declaration file).
 *   Silent, the same rule loaders follow for external modules.
 * - `top-level`: a function or variable declared at the top level of a repository file, with a
 *   symbol in the graph.
 * - `other`: a parameter, a local, or a value with no symbol of its own. Reported as unresolved.
 */
type Reference =
  | { readonly kind: 'external' }
  | { readonly kind: 'top-level'; readonly id: string }
  | { readonly kind: 'other' };

/**
 * Callback flow: a configured function receives a callback, so the caller `passesCallback` the
 * callback.
 *
 * - A named callback (`onReady(ready)`) that is a top-level symbol links to it, with `ts-program`
 *   evidence.
 * - An inline callback (`onReady(() => {})`) has no symbol, so the edge targets the enclosing
 *   symbol and carries `metadata.inline`. This makes the edge a self-loop, which is intended.
 * - Any other callback that is not from an external module (a parameter, a local, a call such as
 *   `makeHandler()`) is an `unresolved-callback` observation, linked from the caller at low
 *   confidence. No edge names a target.
 *
 * Callbacks are kept apart from calls: a callback is passed, not invoked, so no `calls` edge is
 * drawn for it.
 */
export function collectCallbackRelationships(
  repository: RepositoryProgram,
  graph: ConnectionGraph,
  callbacks: readonly CallbackProtocol[],
): void {
  if (callbacks.length === 0) return;
  const byName = new Map(callbacks.map((protocol) => [protocol.function, protocol]));
  const pathOf = new Map(
    [...repository.sourceFiles].map(([filePath, sourceFile]) => [sourceFile, filePath]),
  );

  for (const [filePath, sourceFile] of sortedFiles(repository)) {
    if (sourceFile.isDeclarationFile) continue;

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const name = calleeName(node);
        const protocol = name !== undefined ? byName.get(name) : undefined;
        const argument = protocol ? node.arguments[protocol.callbackArg] : undefined;
        if (argument) {
          recordCallback(node, argument, filePath, sourceFile, repository, graph, pathOf);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
}

function recordCallback(
  call: ts.CallExpression,
  argument: ts.Expression,
  filePath: string,
  sourceFile: ts.SourceFile,
  repository: RepositoryProgram,
  graph: ConnectionGraph,
  pathOf: ReadonlyMap<ts.SourceFile, string>,
): void {
  const source = enclosingOwner(call, filePath);
  const span = spanOf(argument, filePath);
  const node = unwrapExpression(argument);

  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    graph.addRelationship('passesCallback', source, source, 'high', {
      evidence: 'ast',
      spans: [span],
      metadata: { inline: true },
    });
    return;
  }

  if (ts.isIdentifier(node)) {
    const reference = classify(node, repository, graph, pathOf);
    if (reference.kind === 'external') return;
    if (reference.kind === 'top-level') {
      graph.addRelationship('passesCallback', source, reference.id, 'high', {
        evidence: 'ts-program',
        spans: [span],
      });
      return;
    }
    reportUnresolved(graph, source, node.getText(sourceFile), span);
    return;
  }

  // Anything else (a call, a property access) is silent when it starts from an external module.
  const root = rootIdentifier(node);
  if (root !== undefined && classify(root, repository, graph, pathOf).kind === 'external') return;
  reportUnresolved(graph, source, node.getText(sourceFile), span);
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

function reportUnresolved(
  graph: ConnectionGraph,
  source: string,
  subject: string,
  span: ReturnType<typeof spanOf>,
): void {
  const unresolved = graph.addUnresolved({
    reason: 'unresolved-callback',
    attempted: 'passesCallback',
    subject,
    location: span,
    detail:
      'the callback is not a function or value declared at the top level of a repository file',
  });
  graph.addRelationship('passesCallback', source, unresolved.id, 'low', {
    evidence: 'ts-program',
    spans: [span],
  });
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

function sortedFiles(repository: RepositoryProgram): [string, ts.SourceFile][] {
  return [...repository.sourceFiles].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
