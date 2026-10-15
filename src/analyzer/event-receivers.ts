import * as ts from 'typescript';
import type { Evidence } from '../types.js';
import type { EventProtocolCatalog, ReceiverRule } from './event-protocols.js';
import { matchesNameOrType } from './receiver-rules.js';

export { ReceiverResolver, type ReceiverIdentity } from './receiver-identity.js';

export interface ReceiverQualification {
  readonly qualifies: boolean;
  /** `ast`: the method name was enough; `ts-program`: type evidence; `config`: a configured rule */
  readonly evidence: Evidence;
  readonly reason?: string;
}

/** Decide whether a receiver is covered by a protocol's receiver rule. */
export function qualifyReceiver(
  rule: ReceiverRule,
  receiver: ts.Expression,
  catalog: EventProtocolCatalog,
  checker: ts.TypeChecker,
): ReceiverQualification {
  if (rule === 'any') return { qualifies: true, evidence: 'ast' };

  if (rule === 'event-like') {
    const type = checker.getNonNullableType(checker.getTypeAtLocation(receiver));
    const members = new Set(
      checker.getPropertiesOfType(type).map((property) => property.getName()),
    );
    const subscribes = catalog
      .evidenceMethodsFor('subscribe')
      .some((method) => members.has(method));
    const publishes = catalog
      .evidenceMethodsFor('emit', 'dispatch')
      .some((method) => members.has(method));
    if (subscribes && publishes) return { qualifies: true, evidence: 'ts-program' };
    return {
      qualifies: false,
      evidence: 'ts-program',
      reason:
        members.size === 0
          ? 'receiver type is not known'
          : 'receiver type lacks both a subscribe method and an emit or dispatch method',
    };
  }

  return matchesNameOrType(rule, receiver, checker)
    ? { qualifies: true, evidence: 'config' }
    : { qualifies: false, evidence: 'config', reason: 'receiver matches neither names nor types' };
}
