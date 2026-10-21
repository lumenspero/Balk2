import * as ts from 'typescript';
import type { ConnectionGraph } from '../graph.js';
import type { ArgValue, CallSite, Fact, FileFacts } from '../facts/types.js';
import { METADATA_DEFINE_METHODS, METADATA_READ_METHODS } from '../facts/metadata-engine.js';
import { enclosingOwner } from './owner.js';
import { createPathLookup } from './repository-files.js';
import type { RepositoryProgram } from './repository-program.js';
import { symbolTargetOf } from './registry-targets.js';
import { snippetOf, spanOf } from './spans.js';
import { resolveStaticKey } from './static-keys.js';

/** `Reflect.defineMetadata(key, value, target)`: the target is the third argument. */
const DEFINE_TARGET_ARG = 2;
/** `Reflect.getMetadata(key, target)`: the target is the second argument. */
const READ_TARGET_ARG = 1;

/**
 * The TypeScript front end for Reflect metadata. Every direct call on the global `Reflect` name
 * with a metadata method becomes a call fact. Its key is read as a static string, a dynamic value
 * or a non-name, and its target as a symbol when one can be read.
 */
export function extractMetadataFacts(
  repository: RepositoryProgram,
  graph: ConnectionGraph,
): FileFacts[] {
  const checker = repository.checker;
  const pathOf = createPathLookup(repository);
  const files: FileFacts[] = [];

  for (const [filePath, sourceFile] of sortedFiles(repository)) {
    if (sourceFile.isDeclarationFile) continue;

    const facts: Fact[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const call = reflectCallFact(node, filePath, graph, pathOf, checker);
        if (call !== undefined) facts.push(call);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    files.push({ filePath, language: languageOf(filePath), facts });
  }
  return files;
}

function reflectCallFact(
  call: ts.CallExpression,
  filePath: string,
  graph: ConnectionGraph,
  pathOf: ReturnType<typeof createPathLookup>,
  checker: ts.TypeChecker,
): CallSite | undefined {
  const callee = call.expression;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== 'Reflect'
  ) {
    return undefined;
  }

  const method = callee.name.text;
  const isDefine = METADATA_DEFINE_METHODS.includes(method);
  const isRead = METADATA_READ_METHODS.includes(method);
  if (!isDefine && !isRead) return undefined;

  const keyArgument = call.arguments[0];
  const targetIndex = isDefine ? DEFINE_TARGET_ARG : READ_TARGET_ARG;
  const targetArgument = call.arguments[targetIndex];
  if (!keyArgument || !targetArgument) return undefined;

  const key = resolveStaticKey(keyArgument, checker);
  const keyValue: ArgValue =
    key.kind === 'static'
      ? { kind: 'string', value: key.name }
      : key.kind === 'dynamic'
        ? { kind: 'dynamic', reason: key.reason }
        : { kind: 'not-a-name' };
  const targetId = symbolTargetOf(targetArgument, checker, graph, pathOf);
  const targetValue: ArgValue =
    targetId === undefined ? { kind: 'unknown' } : { kind: 'symbol', id: targetId };

  return {
    kind: 'call',
    filePath,
    span: spanOf(call, filePath),
    owner: enclosingOwner(call, filePath),
    name: method,
    methodName: method,
    text: snippetOf(call),
    positional: Array.from({ length: call.arguments.length }, (_, index) => {
      if (index === 0) return keyValue;
      if (index === targetIndex) return targetValue;
      return { kind: 'unknown' } satisfies ArgValue;
    }),
    keyword: {},
  };
}

function languageOf(filePath: string): FileFacts['language'] {
  return /\.(ts|tsx|mts|cts)$/.test(filePath) ? 'typescript' : 'javascript';
}

function sortedFiles(repository: RepositoryProgram): [string, ts.SourceFile][] {
  return [...repository.sourceFiles].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
