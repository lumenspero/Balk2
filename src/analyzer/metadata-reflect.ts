import * as ts from 'typescript';
import type { ConnectionGraph } from '../graph.js';
import type { UnresolvedReason, SourceSpan } from '../types.js';
import {
  METADATA_DEFINE_METHODS,
  METADATA_READ_METHODS,
  type MetadataProtocol,
} from './metadata-protocols.js';
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
 * Reflect metadata with a configured key. A define links the target symbol to the metadata key
 * (`definesMetadata`); a read links the enclosing owner to it (`readsMetadata`).
 *
 * - A key that is not configured is ignored, so unrelated `Reflect` calls stay silent.
 * - A key that is not a constant, or a target that is not a top-level declaration or class member,
 *   is an `unresolved-metadata-key` observation linked from the owner at low confidence.
 * - Only direct calls on the global `Reflect` name are read.
 */
export function collectMetadataRelationships(
  repository: RepositoryProgram,
  graph: ConnectionGraph,
  protocols: readonly MetadataProtocol[],
): void {
  if (protocols.length === 0) return;
  const byKey = new Map(protocols.map((protocol) => [protocol.key, protocol]));
  const checker = repository.checker;
  const pathOf = createPathLookup(repository);

  for (const [filePath, sourceFile] of sortedFiles(repository)) {
    if (sourceFile.isDeclarationFile) continue;

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        inspectCall(node, filePath, byKey, repository, graph, pathOf, checker);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
}

function inspectCall(
  call: ts.CallExpression,
  filePath: string,
  byKey: ReadonlyMap<string, MetadataProtocol>,
  repository: RepositoryProgram,
  graph: ConnectionGraph,
  pathOf: ReturnType<typeof createPathLookup>,
  checker: ts.TypeChecker,
): void {
  const callee = call.expression;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== 'Reflect'
  ) {
    return;
  }

  const method = callee.name.text;
  const isDefine = METADATA_DEFINE_METHODS.includes(method);
  const isRead = METADATA_READ_METHODS.includes(method);
  if (!isDefine && !isRead) return;

  const keyArgument = call.arguments[0];
  const targetArgument = call.arguments[isDefine ? DEFINE_TARGET_ARG : READ_TARGET_ARG];
  if (!keyArgument || !targetArgument) return;

  const span = spanOf(call, filePath);
  const owner = enclosingOwner(call, filePath);
  const attempted = isDefine ? 'definesMetadata' : 'readsMetadata';

  const observe = (reason: UnresolvedReason, detail: string): void => {
    const unresolved = graph.addUnresolved({
      reason,
      attempted,
      subject: snippetOf(call),
      location: span,
      detail,
    });
    graph.addRelationship(attempted, owner, unresolved.id, 'low', {
      evidence: 'ts-program',
      spans: [span],
    });
  };

  const key = resolveStaticKey(keyArgument, checker);
  if (key.kind === 'not-a-name') return;
  if (key.kind === 'dynamic') {
    observe('unresolved-metadata-key', key.reason);
    return;
  }

  const protocol = byKey.get(key.name);
  if (!protocol) return;
  if (isDefine ? protocol.defines !== true : protocol.reads !== true) return;

  const target = symbolTargetOf(targetArgument, checker, graph, pathOf);
  if (target === undefined) {
    observe(
      'unresolved-metadata-key',
      'the target is not a top-level declaration or class member, so it has no symbol',
    );
    return;
  }

  const keyNode = graph.addMetadataKey(key.name);
  const relationship = {
    evidence: 'ts-program' as const,
    spans: [span],
  };
  if (isDefine) {
    graph.addRelationship('definesMetadata', target, keyNode.id, 'high', relationship);
  } else {
    graph.addRelationship('readsMetadata', owner, keyNode.id, 'high', relationship);
  }
  void repository;
}

function sortedFiles(repository: RepositoryProgram): [string, ts.SourceFile][] {
  return [...repository.sourceFiles].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export type { SourceSpan };
