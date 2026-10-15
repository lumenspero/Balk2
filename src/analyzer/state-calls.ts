import * as ts from 'typescript';
import type { DynamicPathMode, StateConfig } from '../config/state-config.js';
import type { SourceSpan, StatePathSegment, StateRelationship } from '../types.js';
import { enclosingOwner } from './owner.js';
import { snippetOf, spanOf } from './spans.js';
import { unwrapExpression } from './static-keys.js';
import {
  BUILT_IN_STATE_PROTOCOLS,
  type StateAccess,
  type StateProtocol,
} from './state-protocols.js';
import type { KeySegment, StateReference, StateRootResolver } from './state-roots.js';

/** How state methods are matched, from the `state` config section. */
export interface StateCallOptions {
  /** Effective methods by name: the enabled built-ins, overridden or extended by project methods */
  readonly protocols: ReadonlyMap<string, StateProtocol>;
  readonly dynamicPaths: DynamicPathMode;
}

/**
 * A call to a state method on a resolved state root, such as `store.get('user')`. A call is
 * behavior, so its operation is always `call`; the method is kept for the edge's metadata.
 */
export interface StateCallFact {
  readonly relationship: StateRelationship;
  readonly operation: 'call';
  readonly method: string;
  readonly reference: StateReference;
  readonly owner: string;
  readonly span: SourceSpan;
  readonly subject: string;
}

/**
 * A state method call whose key is not statically known, when `dynamicPaths` is `off`. It is
 * reported as an unresolved `dynamic-state-path` rather than recorded as an edge.
 */
export interface StateCallObservation {
  readonly method: string;
  /** The receiver's state, before the dynamic key */
  readonly receiver: StateReference;
  readonly reason: string;
  readonly owner: string;
  readonly span: SourceSpan;
  readonly subject: string;
}

export interface StateCallReport {
  readonly calls: readonly StateCallFact[];
  readonly unresolved: readonly StateCallObservation[];
  /**
   * Every call a state method matched, whether or not it was recorded. Registry detection must
   * skip these: when a receiver is shared state, the call is state, not a registry lookup.
   */
  readonly claimed: ReadonlySet<ts.CallExpression>;
}

const RELATIONSHIPS: Readonly<Record<StateAccess, StateRelationship>> = {
  read: 'readsState',
  write: 'writesState',
  delete: 'deletesState',
};

/** The effective method table: enabled built-ins, then project methods (which replace by name). */
export function stateCallOptions(config: StateConfig = {}): StateCallOptions {
  const protocols = new Map<string, StateProtocol>();
  if (config.builtIns !== false) {
    const disabled = new Set(config.disable ?? []);
    for (const protocol of BUILT_IN_STATE_PROTOCOLS) {
      if (!disabled.has(protocol.method)) protocols.set(protocol.method, protocol);
    }
  }
  for (const protocol of config.methods ?? []) protocols.set(protocol.method, protocol);
  return { protocols, dynamicPaths: config.dynamicPaths ?? 'off' };
}

/**
 * Every call to a state method in one file. A call matches only when its receiver already
 * resolves to shared state, so a `get` on an unrelated object is never recorded.
 */
export function collectStateCalls(
  sourceFile: ts.SourceFile,
  filePath: string,
  resolver: StateRootResolver,
  options: StateCallOptions,
): StateCallReport {
  const calls: StateCallFact[] = [];
  const unresolved: StateCallObservation[] = [];
  const claimed = new Set<ts.CallExpression>();

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const matched = matchCall(node, filePath, resolver, options);
      if (matched) {
        claimed.add(node);
        if (matched.call) calls.push(matched.call);
        if (matched.unresolved) unresolved.push(matched.unresolved);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  calls.sort(
    (a, b) =>
      compareSpans(a.span, b.span) ||
      (a.relationship < b.relationship ? -1 : a.relationship > b.relationship ? 1 : 0) ||
      (a.method < b.method ? -1 : a.method > b.method ? 1 : 0),
  );
  unresolved.sort((a, b) => compareSpans(a.span, b.span) || (a.method < b.method ? -1 : 1));
  return { calls, unresolved, claimed };
}

interface Matched {
  readonly call?: StateCallFact;
  readonly unresolved?: StateCallObservation;
}

function matchCall(
  call: ts.CallExpression,
  filePath: string,
  resolver: StateRootResolver,
  options: StateCallOptions,
): Matched | undefined {
  const callee = unwrapExpression(call.expression);
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) {
    return undefined;
  }

  const method = methodNameOf(callee, resolver);
  if (method === undefined) return undefined;
  const protocol = options.protocols.get(method);
  if (!protocol) return undefined;

  const receiver = resolver.resolve(callee.expression);
  if (!receiver) return undefined;

  const key = keyPathOf(call, protocol, resolver);
  const dynamicReason = receiver.dynamicReason ?? key.dynamicReason;
  const owner = enclosingOwner(call, filePath);
  const span = spanOf(call, filePath);
  const subject = snippetOf(call);

  if (dynamicReason !== undefined && options.dynamicPaths === 'off') {
    return {
      unresolved: { method, receiver, reason: dynamicReason, owner, span, subject },
    };
  }

  const reference: StateReference = {
    root: receiver.root,
    rootKind: receiver.rootKind,
    segments: [...receiver.segments, ...key.segments],
    confidence: receiver.confidence,
    evidence: receiver.evidence,
    ...(dynamicReason !== undefined ? { dynamicReason } : {}),
  };
  return {
    call: {
      relationship: RELATIONSHIPS[protocol.access],
      operation: 'call',
      method,
      reference,
      owner,
      span,
      subject,
    },
  };
}

/** `store.get` names `get`; `store['get']` names `get` when the key is static. */
function methodNameOf(
  callee: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  resolver: StateRootResolver,
): string | undefined {
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  const key = resolver.keySegment(callee.argumentExpression);
  return key.name ?? undefined;
}

interface KeyPath {
  readonly segments: readonly StatePathSegment[];
  /** Why the key is not static, when it is not */
  readonly dynamicReason?: string;
}

/**
 * The path a call touches below its receiver. Without `keyArg` the call touches the receiver
 * itself. With `pathSeparator`, one string key is split into a path.
 */
function keyPathOf(
  call: ts.CallExpression,
  protocol: StateProtocol,
  resolver: StateRootResolver,
): KeyPath {
  if (protocol.keyArg === undefined) return { segments: [] };

  const index = protocol.keyArg;
  // A spread before the key argument makes its position unknown.
  if (call.arguments.slice(0, index + 1).some((argument) => ts.isSpreadElement(argument))) {
    return dynamicKey('spread argument');
  }
  const argument = call.arguments[index];
  if (argument === undefined) return dynamicKey('missing key argument');

  const key: KeySegment = resolver.keySegment(argument);
  if (key.name === null) return dynamicKey(key.reason);
  if (protocol.pathSeparator === undefined) return { segments: [key.name] };
  return { segments: key.name.split(protocol.pathSeparator) };
}

function dynamicKey(reason: string): KeyPath {
  return { segments: [null], dynamicReason: reason };
}

function compareSpans(a: SourceSpan, b: SourceSpan): number {
  return a.startLine - b.startLine || a.startColumn - b.startColumn;
}
