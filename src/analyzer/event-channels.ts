import * as ts from 'typescript';
import type { ConnectionGraph } from '../graph.js';
import type { Evidence, RelationshipMetadata, UnresolvedReason } from '../types.js';
import { ListenerResolver } from './event-listeners.js';
import { readListenerOptions } from './event-options.js';
import { resolveEventName, resolveEventObject, unwrapExpression } from './event-names.js';
import {
  EventProtocolCatalog,
  type EventDirection,
  type EventProtocolOptions,
  type ResolvedEventProtocol,
} from './event-protocols.js';
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
 * Event pass: map protocol calls (`bus.on('ready', fn)`, `bus.emit('ready')`,
 * `target.dispatchEvent(new Event('ready'))`, ...) onto event channels.
 *
 * A channel is named by the event and scoped by the identity of the receiver, so unrelated
 * emitters that reuse a name stay separate. Publishers link to the channel with `emits` or
 * `dispatches`, listeners with `subscribes` and `unsubscribes`. Whatever cannot be resolved
 * without guessing (a dynamic name, an unidentifiable receiver, a receiver that does not look
 * like an emitter) becomes an unresolved observation linked by a low-confidence relationship.
 *
 * Runs after the per-file pass, so listener symbols already exist in the graph.
 */
export function collectEventRelationships(
  repository: RepositoryProgram,
  graph: ConnectionGraph,
  options: EventProtocolOptions = {},
  claimed: ReadonlySet<ts.Node> = new Set(),
): void {
  const catalog = new EventProtocolCatalog(options);
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

  const calls = collectProtocolCalls(repository, catalog);

  // Usage evidence: a receiver used both to listen and to publish is an emitter even when
  // its type says nothing (untyped JavaScript).
  const directions = new Map<string, Set<EventDirection>>();
  for (const { receiver, protocol } of calls) {
    const identity = identityOf(receiver);
    if (identity.kind !== 'resolved') continue;
    const seen = directions.get(identity.scope) ?? new Set<EventDirection>();
    seen.add(protocol.direction);
    directions.set(identity.scope, seen);
  }
  const usedAsEmitter = (scope: string): boolean => {
    const seen = directions.get(scope);
    return (
      seen !== undefined && seen.has('subscribe') && (seen.has('emit') || seen.has('dispatch'))
    );
  };

  for (const { filePath, call, receiver, protocol } of calls) {
    // State takes precedence: a call on shared state is never an event.
    if (claimed.has(call)) continue;
    const eventArgument = call.arguments[protocol.eventArg];
    if (!eventArgument) continue;

    const name =
      protocol.eventArgKind === 'event-object'
        ? resolveEventObject(eventArgument, checker)
        : resolveEventName(eventArgument, checker);
    if (name.kind === 'not-a-name') continue;

    const owner = enclosingOwner(call, filePath);
    const span = spanOf(call, filePath);
    const identity = identityOf(receiver);
    const qualification = qualifyReceiver(protocol.receiver, receiver, catalog, checker);

    const observe = (reason: UnresolvedReason, detail: string): void => {
      const node = graph.addUnresolved({
        reason,
        attempted: protocol.relationship,
        subject: describeCall(call),
        location: span,
        detail,
      });
      graph.addRelationship(protocol.relationship, owner, node.id, 'low', {
        evidence: 'ts-program',
        spans: [span],
      });
    };

    let qualified = qualification.qualifies;
    let heuristic = false;
    if (
      !qualified &&
      protocol.receiver === 'event-like' &&
      identity.kind === 'resolved' &&
      usedAsEmitter(identity.scope)
    ) {
      qualified = true;
      heuristic = true;
    }

    if (!qualified) {
      // An unmatched names/types rule is a deliberate exclusion; only an unrecognized
      // receiver of a generic method name is worth a note.
      if (protocol.receiver === 'event-like' && name.kind === 'static') {
        observe(
          'unknown-event-receiver',
          qualification.reason ?? 'receiver is not recognized as an event emitter',
        );
      }
      continue;
    }

    if (name.kind === 'dynamic') {
      observe('dynamic-event-name', name.reason);
      continue;
    }

    if (identity.kind === 'unknown') {
      observe('unknown-event-receiver', identity.reason);
      continue;
    }

    const channel = graph.addEventChannel(name.name, identity.scope);
    const metadata: Record<string, string | number | boolean> = {};
    if (protocol.once) metadata['once'] = true;

    let from = owner;
    if (protocol.direction === 'subscribe' || protocol.direction === 'unsubscribe') {
      const listener =
        protocol.listenerArg !== undefined
          ? listeners.ownerOf(call.arguments[protocol.listenerArg])
          : undefined;
      if (listener && protocol.direction === 'subscribe') {
        from = listener;
        if (listener !== owner) metadata['registeredBy'] = owner;
      } else if (listener) {
        metadata['listener'] = listener;
      }

      if (protocol.optionsArg !== undefined) {
        Object.assign(
          metadata,
          readListenerOptions(call.arguments[protocol.optionsArg], checker, protocol.direction),
        );
      }
    }

    graph.addRelationship(
      protocol.relationship,
      from,
      channel.id,
      heuristic || identity.confidence !== 'high' ? 'medium' : 'high',
      {
        evidence: evidenceOf(heuristic, protocol, qualification.evidence),
        spans: [span],
        ...(Object.keys(metadata).length > 0 ? { metadata: metadata as RelationshipMetadata } : {}),
      },
    );
  }
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

/** `heuristic` when usage evidence was needed, else `config` for configured rules, else the compiler. */
function evidenceOf(
  heuristic: boolean,
  protocol: ResolvedEventProtocol,
  qualification: Evidence,
): Evidence {
  if (heuristic) return 'heuristic';
  return protocol.source === 'config' || qualification === 'config' ? 'config' : 'ts-program';
}

/** A short, single-line rendering of the call, for the observation's subject. */
function describeCall(call: ts.CallExpression): string {
  const sourceFile = call.getSourceFile();
  const callee = call.expression.getText(sourceFile);
  const first = call.arguments[0]?.getText(sourceFile) ?? '';
  const more = call.arguments.length > 1 ? ', …' : '';
  const text = `${callee}(${first}${more})`.replace(/\s+/g, ' ');
  return text.length > MAX_SUBJECT_LENGTH ? `${text.slice(0, MAX_SUBJECT_LENGTH - 1)}…` : text;
}
