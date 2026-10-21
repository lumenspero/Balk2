import * as ts from 'typescript';
import type { ConnectionGraph } from '../graph.js';
import type {
  EventCallFact,
  EventDirectionFact,
  EventListenerFlags,
  EventNameFact,
  EventReceiverFact,
} from '../facts/types.js';
import { ListenerResolver } from './event-listeners.js';
import { readListenerOptions } from './event-options.js';
import { resolveEventName, resolveEventObject, unwrapExpression } from './event-names.js';
import { EventProtocolCatalog, type ResolvedEventProtocol } from './event-protocols.js';
import { qualifyReceiver, ReceiverResolver, type ReceiverIdentity } from './event-receivers.js';
import { enclosingOwner } from './owner.js';
import type { RepositoryProgram } from './repository-program.js';
import { spanOf } from './spans.js';

interface ProtocolCall {
  readonly filePath: string;
  readonly call: ts.CallExpression;
  readonly receiver: ts.Expression;
  readonly protocol: ResolvedEventProtocol;
}

const MAX_SUBJECT_LENGTH = 80;

/**
 * Front end for event calls: every method call whose name has an event protocol, read once with
 * its receiver, name, listener and options. Claimed calls are included and flagged, because they
 * still count as evidence that a receiver is an emitter. Reads only; the engine decides what each
 * one links to.
 */
export function extractEventFacts(
  repository: RepositoryProgram,
  graph: ConnectionGraph,
  catalog: EventProtocolCatalog,
  claimed: ReadonlySet<ts.Node>,
): EventCallFact[] {
  const receivers = new ReceiverResolver(repository);
  const listeners = new ListenerResolver(repository, graph);
  const checker = repository.checker;

  const identities = new WeakMap<ts.Node, ReceiverIdentity>();
  const identityOf = (receiver: ts.Expression): ReceiverIdentity => {
    let identity = identities.get(receiver);
    if (!identity) {
      identity = receivers.resolve(receiver);
      identities.set(receiver, identity);
    }
    return identity;
  };

  return collectProtocolCalls(repository, catalog).map(({ filePath, call, receiver, protocol }) => {
    const qualification = qualifyReceiver(protocol.receiver, receiver, catalog, checker);
    const listener = isListenerDirection(protocol.direction)
      ? listenerOf(call, protocol, listeners)
      : undefined;
    const options = isListenerDirection(protocol.direction)
      ? optionsOf(call, protocol, checker)
      : undefined;

    const receiverFact: EventReceiverFact = {
      identity: identityFact(identityOf(receiver)),
      qualifies: qualification.qualifies,
      qualificationEvidence: qualification.evidence,
      ...(qualification.reason !== undefined ? { reason: qualification.reason } : {}),
    };

    return {
      kind: 'event-call',
      filePath,
      span: spanOf(call, filePath),
      owner: enclosingOwner(call, filePath),
      subject: describeCall(call),
      direction: protocol.direction,
      relationship: protocol.relationship,
      protocolSource: protocol.source,
      eventLikeReceiver: protocol.receiver === 'event-like',
      once: protocol.once,
      claimed: claimed.has(call),
      receiver: receiverFact,
      name: nameOf(call, protocol, checker),
      ...(listener !== undefined ? { listener } : {}),
      ...(options !== undefined ? { options } : {}),
    };
  });
}

/** Every method call whose name has a protocol, in a stable order. */
function collectProtocolCalls(
  repository: RepositoryProgram,
  catalog: EventProtocolCatalog,
): ProtocolCall[] {
  const found: ProtocolCall[] = [];
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
        if (protocol && receiver) found.push({ filePath, call: node, receiver, protocol });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return found;
}

function isListenerDirection(
  direction: EventDirectionFact,
): direction is 'subscribe' | 'unsubscribe' {
  return direction === 'subscribe' || direction === 'unsubscribe';
}

function listenerOf(
  call: ts.CallExpression,
  protocol: ResolvedEventProtocol,
  listeners: ListenerResolver,
): string | undefined {
  return protocol.listenerArg !== undefined
    ? listeners.ownerOf(call.arguments[protocol.listenerArg])
    : undefined;
}

function optionsOf(
  call: ts.CallExpression,
  protocol: ResolvedEventProtocol,
  checker: ts.TypeChecker,
): EventListenerFlags | undefined {
  if (protocol.optionsArg === undefined || !isListenerDirection(protocol.direction)) {
    return undefined;
  }
  return readListenerOptions(call.arguments[protocol.optionsArg], checker, protocol.direction);
}

/** The name an argument gives, read as a name or as the name of an event object. */
function nameOf(
  call: ts.CallExpression,
  protocol: ResolvedEventProtocol,
  checker: ts.TypeChecker,
): EventNameFact {
  const argument = call.arguments[protocol.eventArg];
  if (!argument) return { kind: 'not-a-name' };

  const resolved =
    protocol.eventArgKind === 'event-object'
      ? resolveEventObject(argument, checker)
      : resolveEventName(argument, checker);
  if (resolved.kind === 'static') return { kind: 'static', name: resolved.name };
  if (resolved.kind === 'dynamic') return { kind: 'dynamic', reason: resolved.reason };
  return { kind: 'not-a-name' };
}

function identityFact(identity: ReceiverIdentity): EventReceiverFact['identity'] {
  return identity.kind === 'resolved'
    ? { kind: 'resolved', scope: identity.scope, confidence: identity.confidence }
    : { kind: 'unknown', reason: identity.reason };
}

/** A short, single-line rendering of the call, for an observation's subject. */
function describeCall(call: ts.CallExpression): string {
  const sourceFile = call.getSourceFile();
  const callee = call.expression.getText(sourceFile);
  const first = call.arguments[0]?.getText(sourceFile) ?? '';
  const more = call.arguments.length > 1 ? ', …' : '';
  const text = `${callee}(${first}${more})`.replace(/\s+/g, ' ');
  return text.length > MAX_SUBJECT_LENGTH ? `${text.slice(0, MAX_SUBJECT_LENGTH - 1)}…` : text;
}
