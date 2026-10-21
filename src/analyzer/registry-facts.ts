import * as ts from 'typescript';
import type { ConnectionGraph } from '../graph.js';
import type { RegistryCallFact, RegistryReceiverFact } from '../facts/types.js';
import { enclosingOwner } from './owner.js';
import { createPathLookup, type PathLookup } from './repository-files.js';
import type { RepositoryProgram } from './repository-program.js';
import { ReceiverResolver, type ReceiverIdentity } from './receiver-identity.js';
import {
  keyFactOf,
  resolveRegistryKey,
  resolveTypeArgumentKey,
  type RegistryKeyResolution,
} from './registry-keys.js';
import type { RegistryProtocolCatalog, ResolvedRegistryProtocol } from './registry-protocols.js';
import { qualifyRegistryReceiver, type RegistryContainer } from './registry-receivers.js';
import { symbolTargetOf } from './registry-targets.js';
import { snippetOf, spanOf } from './spans.js';
import { unwrapExpression } from './static-keys.js';

/** The protocol for a dictionary assignment: `registry[key] = value`. */
const ASSIGNMENT: ResolvedRegistryProtocol = {
  method: '[]=',
  direction: 'register',
  relationship: 'registers',
  keyArg: 0,
  valueArg: 1,
  receiver: 'registry-like',
  source: 'built-in',
};

/** A candidate read from source, before its receiver and key are resolved. */
interface RegistryCall {
  readonly filePath: string;
  /** The call expression, or the assignment expression */
  readonly node: ts.Expression;
  readonly receiver: ts.Expression;
  /** The key argument, when the protocol reads its key from an argument */
  readonly keyExpression: ts.Expression | undefined;
  /** The type argument, when the protocol reads its key from the type (`keyFrom: 'typeArgument'`) */
  readonly typeArgument: ts.TypeNode | undefined;
  readonly valueExpression: ts.Expression | undefined;
  readonly protocol: ResolvedRegistryProtocol;
  readonly assignment: boolean;
}

interface CallContext {
  readonly receivers: ReceiverResolver;
  readonly catalog: RegistryProtocolCatalog;
  readonly checker: ts.TypeChecker;
  readonly graph: ConnectionGraph;
  readonly pathOf: PathLookup;
}

/**
 * Front end for registry calls: every call whose method has a registry protocol, and every
 * dictionary assignment, read once with its receiver and key resolved. Calls the state pass
 * claimed are skipped.
 *
 * A fact is emitted for every candidate that has a key, including ones the engine will skip. A
 * registry's standing (which scopes count as registries) depends on every candidate that makes a
 * symbol-valued registration, whether or not that candidate qualifies.
 */
export function extractCallFacts(
  repository: RepositoryProgram,
  graph: ConnectionGraph,
  catalog: RegistryProtocolCatalog,
  claimed: ReadonlySet<ts.Node>,
): RegistryCallFact[] {
  const ctx: CallContext = {
    receivers: new ReceiverResolver(repository),
    catalog,
    checker: repository.checker,
    graph,
    pathOf: createPathLookup(repository),
  };
  return collectRegistryCalls(repository, catalog)
    .filter((call) => !claimed.has(call.node))
    .map((call) => callFact(call, ctx));
}

function callFact(call: RegistryCall, ctx: CallContext): RegistryCallFact {
  const identity = ctx.receivers.resolve(call.receiver);
  const qualification = qualifyRegistryReceiver(
    call.protocol.receiver,
    call.receiver,
    ctx.catalog,
    ctx.checker,
  );
  const target = call.valueExpression
    ? symbolTargetOf(call.valueExpression, ctx.checker, ctx.graph, ctx.pathOf)
    : undefined;
  const resolution = keyOf(call, ctx.checker, qualification.container);
  const receiver: RegistryReceiverFact = {
    identity: identityFact(identity),
    qualifies: qualification.qualifies,
    qualificationEvidence: qualification.evidence,
    internal: qualification.internal,
  };

  return {
    kind: 'registry-call',
    filePath: call.filePath,
    span: spanOf(call.node, call.filePath),
    owner: enclosingOwner(call.node, call.filePath),
    subject: snippetOf(call.node),
    assignment: call.assignment,
    relationship: call.protocol.relationship,
    protocolSource: call.protocol.source,
    configuredReceiver: call.protocol.receiver !== 'registry-like',
    receiver,
    key: resolution ? keyFactOf(resolution) : { kind: 'not-a-name' },
    ...(target !== undefined ? { target } : {}),
  };
}

function identityFact(identity: ReceiverIdentity): RegistryReceiverFact['identity'] {
  return identity.kind === 'resolved'
    ? { kind: 'resolved', scope: identity.scope, confidence: identity.confidence }
    : { kind: 'unknown', reason: identity.reason };
}

/** The key a call names: from its type argument when the protocol says so, otherwise its argument. */
function keyOf(
  call: RegistryCall,
  checker: ts.TypeChecker,
  container: RegistryContainer,
): RegistryKeyResolution | undefined {
  if (call.typeArgument) return resolveTypeArgumentKey(call.typeArgument, checker, container);
  if (call.keyExpression) return resolveRegistryKey(call.keyExpression, checker, container);
  return undefined;
}

/**
 * Every call whose method has a registry protocol, and every dictionary assignment, in a stable
 * order. A protocol that reads its key from a type argument needs one; a call without it is not a
 * candidate.
 */
function collectRegistryCalls(
  repository: RepositoryProgram,
  catalog: RegistryProtocolCatalog,
): RegistryCall[] {
  const found: RegistryCall[] = [];
  const files = [...repository.sourceFiles].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  for (const [filePath, sourceFile] of files) {
    if (sourceFile.isDeclarationFile) continue;

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = unwrapExpression(node.expression);
        let method: string | undefined;
        let receiver: ts.Expression | undefined;

        if (ts.isPropertyAccessExpression(callee)) {
          method = callee.name.text;
          receiver = callee.expression;
        } else if (
          ts.isElementAccessExpression(callee) &&
          ts.isStringLiteralLike(callee.argumentExpression)
        ) {
          method = callee.argumentExpression.text;
          receiver = callee.expression;
        }

        const protocol = method !== undefined ? catalog.forMethod(method) : undefined;
        if (protocol && receiver) {
          const fromType = protocol.keyFrom === 'typeArgument';
          const typeArgument = fromType ? node.typeArguments?.[0] : undefined;
          const keyExpression =
            !fromType && protocol.keyArg !== undefined
              ? node.arguments[protocol.keyArg]
              : undefined;

          if (typeArgument !== undefined || keyExpression !== undefined) {
            found.push({
              filePath,
              node,
              receiver,
              keyExpression,
              typeArgument,
              valueExpression:
                protocol.valueArg !== undefined ? node.arguments[protocol.valueArg] : undefined,
              protocol,
              assignment: false,
            });
          }
        }
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isElementAccessExpression(node.left)
      ) {
        found.push({
          filePath,
          node,
          receiver: node.left.expression,
          keyExpression: node.left.argumentExpression,
          typeArgument: undefined,
          valueExpression: node.right,
          protocol: ASSIGNMENT,
          assignment: true,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return found;
}
