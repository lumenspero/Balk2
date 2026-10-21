import * as ts from 'typescript';
import type {
  ArgValue,
  CallSite,
  Fact,
  FactLanguage,
  FileFacts,
  ModuleEdge,
} from '../facts/types.js';
import { enclosingOwner } from './owner.js';
import type { RepositoryProgram } from './repository-program.js';
import type { ResourceProtocol } from './resource-protocols.js';
import { snippetOf, spanOf } from './spans.js';
import { resolveStaticKey } from './static-keys.js';

/**
 * The TypeScript front end for the resource family. It reads each file's imports and its
 * configured loader calls as facts. The resource engine decides what they link to.
 */
export function extractResourceFacts(
  repository: RepositoryProgram,
  protocols: readonly ResourceProtocol[],
): FileFacts[] {
  const byName = new Map(protocols.map((protocol) => [protocol.function, protocol] as const));

  const files: FileFacts[] = [];
  for (const [filePath, sourceFile] of sortedFiles(repository)) {
    if (sourceFile.isDeclarationFile) continue;

    const facts: Fact[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        facts.push(importFact(node, filePath));
      } else if (byName.size > 0 && ts.isCallExpression(node)) {
        const call = loaderCallFact(node, filePath, byName, repository);
        if (call !== undefined) facts.push(call);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    files.push({ filePath, language: languageOf(filePath), facts });
  }
  return files;
}

function importFact(node: ts.ImportDeclaration, filePath: string): ModuleEdge {
  const specifier = (node.moduleSpecifier as ts.StringLiteral).text;
  return {
    kind: 'module-edge',
    filePath,
    span: spanOf(node, filePath),
    owner: null,
    form: 'import',
    specifier,
    names: [],
    typeOnly: node.importClause?.isTypeOnly ?? false,
  };
}

function loaderCallFact(
  call: ts.CallExpression,
  filePath: string,
  byName: ReadonlyMap<string, ResourceProtocol>,
  repository: RepositoryProgram,
): CallSite | undefined {
  const callee = call.expression;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : undefined;
  const protocol = name !== undefined ? byName.get(name) : undefined;
  if (name === undefined || protocol === undefined) return undefined;

  const argument = call.arguments[protocol.specifierArg];
  if (argument === undefined) return undefined;

  const specifier = argValueOf(argument, repository);
  return {
    kind: 'call',
    filePath,
    span: spanOf(call, filePath),
    owner: enclosingOwner(call, filePath),
    name,
    ...(ts.isPropertyAccessExpression(callee) ? { methodName: name } : {}),
    text: snippetOf(call),
    positional: Array.from({ length: call.arguments.length }, (_, index) =>
      index === protocol.specifierArg ? specifier : ({ kind: 'unknown' } satisfies ArgValue),
    ),
    keyword: {},
  };
}

function argValueOf(argument: ts.Expression, repository: RepositoryProgram): ArgValue {
  const key = resolveStaticKey(argument, repository.checker);
  if (key.kind === 'static') return { kind: 'string', value: key.name };
  if (key.kind === 'dynamic') return { kind: 'dynamic', reason: key.reason };
  return { kind: 'not-a-name' };
}

function languageOf(filePath: string): FactLanguage {
  return /\.(ts|tsx|mts|cts)$/.test(filePath) ? 'typescript' : 'javascript';
}

function sortedFiles(repository: RepositoryProgram): [string, ts.SourceFile][] {
  return [...repository.sourceFiles].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
