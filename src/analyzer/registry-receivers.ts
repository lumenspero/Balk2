import * as ts from 'typescript';
import type { Evidence } from '../types.js';
import type { RegistryProtocolCatalog, RegistryRule } from './registry-protocols.js';
import { matchesNameOrType } from './receiver-rules.js';

/**
 * How a registry keys its entries. This decides whether `1` and `'1'` are the same key.
 *
 * - `object`: a dictionary. JavaScript converts every key to a string, so they are one key.
 * - `typed`: a Map, Set, class or anything else. Keys keep their type, so they are two keys.
 *   Unknown receivers default to `typed`, the conservative choice.
 */
export type RegistryContainer = 'object' | 'typed';

export interface RegistryQualification {
  readonly qualifies: boolean;
  /** `ast`: the method name was enough; `ts-program`: type evidence; `config`: a configured rule */
  readonly evidence: Evidence;
  readonly container: RegistryContainer;
  readonly reason?: string;
}

/** Decide whether a receiver is a registry under a protocol's receiver rule. */
export function qualifyRegistryReceiver(
  rule: RegistryRule,
  receiver: ts.Expression,
  catalog: RegistryProtocolCatalog,
  checker: ts.TypeChecker,
): RegistryQualification {
  if (rule === 'any') return { qualifies: true, evidence: 'ast', container: 'typed' };

  const type = checker.getNonNullableType(checker.getTypeAtLocation(receiver));
  const shape = shapeOf(type, checker, catalog);

  if (rule === 'registry-like') {
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
      return {
        qualifies: false,
        evidence: 'ts-program',
        container: 'typed',
        reason: 'receiver type is not known',
      };
    }
    return shape.registry
      ? { qualifies: true, evidence: 'ts-program', container: shape.container }
      : {
          qualifies: false,
          evidence: 'ts-program',
          container: shape.container,
          reason: 'receiver type is not a registry',
        };
  }

  return matchesNameOrType(rule, receiver, checker)
    ? { qualifies: true, evidence: 'config', container: shape.container }
    : {
        qualifies: false,
        evidence: 'config',
        container: shape.container,
        reason: 'receiver matches neither names nor types',
      };
}

interface Shape {
  readonly registry: boolean;
  readonly container: RegistryContainer;
}

function shapeOf(type: ts.Type, checker: ts.TypeChecker, catalog: RegistryProtocolCatalog): Shape {
  const members = new Set(checker.getPropertiesOfType(type).map((property) => property.getName()));
  const indexes = checker.getIndexInfosOfType(type);

  // An array has a numeric index signature and a length, but its keys are positions, not names.
  const arrayLike =
    members.has('length') &&
    indexes.some((info) => (info.keyType.flags & ts.TypeFlags.NumberLike) !== 0);
  const indexed = indexes.length > 0;

  const registers = catalog.evidenceMethodsFor('register').some((name) => members.has(name));
  const looksUp = catalog.evidenceMethodsFor('resolve', 'route').some((name) => members.has(name));
  const setLike = members.has('add') && members.has('has');

  return {
    registry: !arrayLike && (indexed || setLike || (registers && looksUp)),
    container: indexed && !arrayLike && !registers && !looksUp ? 'object' : 'typed',
  };
}
