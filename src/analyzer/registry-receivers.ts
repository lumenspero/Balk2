import * as ts from 'typescript';
import type { Evidence } from '../types.js';
import type { RegistryProtocolCatalog, RegistryRule } from './registry-protocols.js';
import {
  hasAnyMethod,
  hasMethods,
  RESOLVED_TYPE,
  resolvedTypeQuery,
} from '../facts/type-members.js';
import { matchesNameOrType } from './receiver-rules.js';

/**
 * How a registry keys its entries. This decides whether `1` and `'1'` are the same key.
 *
 * - `object`: a dictionary. JavaScript converts every key to a string, so they are one key.
 * - `typed`: a Map, Set, class or anything else. Keys keep their type, so they are two keys.
 *   Unknown receivers default to `typed`, the conservative choice.
 */
export type RegistryContainer = 'object' | 'typed';

export interface ReceiverQualification {
  readonly qualifies: boolean;
  /** `ast`: the method name was enough; `ts-program`: type evidence; `config`: a configured rule */
  readonly evidence: Evidence;
  readonly container: RegistryContainer;
  readonly reason?: string;
}

export interface RegistryQualification extends ReceiverQualification {
  /**
   * True when the receiver is a built-in container whose storage cannot be reached from outside
   * its module or class (a private member, or a module-level variable that is not exported).
   */
  readonly internal: boolean;
}

/** Decide whether a receiver is a registry under a protocol's receiver rule. */
export function qualifyRegistryReceiver(
  rule: RegistryRule,
  receiver: ts.Expression,
  catalog: RegistryProtocolCatalog,
  checker: ts.TypeChecker,
): RegistryQualification {
  const type = checker.getNonNullableType(checker.getTypeAtLocation(receiver));
  return {
    ...qualifyReceiver(rule, receiver, catalog, checker, type),
    internal: isInternalStorage(type, receiver, checker),
  };
}

function qualifyReceiver(
  rule: RegistryRule,
  receiver: ts.Expression,
  catalog: RegistryProtocolCatalog,
  checker: ts.TypeChecker,
  type: ts.Type,
): ReceiverQualification {
  if (rule === 'any') return { qualifies: true, evidence: 'ast', container: 'typed' };

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
  const names = checker.getPropertiesOfType(type).map((property) => property.getName());
  const members = new Set(names);
  const query = resolvedTypeQuery(names);
  const indexes = checker.getIndexInfosOfType(type);

  // An array has a numeric index signature and a length, but its keys are positions, not names.
  const arrayLike =
    members.has('length') &&
    indexes.some((info) => (info.keyType.flags & ts.TypeFlags.NumberLike) !== 0);
  const indexed = indexes.length > 0;

  const registers = hasAnyMethod(query, RESOLVED_TYPE, catalog.evidenceMethodsFor('register'));
  const looksUp = hasAnyMethod(
    query,
    RESOLVED_TYPE,
    catalog.evidenceMethodsFor('resolve', 'route'),
  );
  const setLike = hasMethods(query, RESOLVED_TYPE, ['add', 'has']);

  return {
    registry: !arrayLike && (indexed || setLike || (registers && looksUp)),
    container: indexed && !arrayLike && !registers && !looksUp ? 'object' : 'typed',
  };
}

/**
 * A built-in container (Map, Set, and other types declared by the TypeScript standard library)
 * whose storage is private: its keys are bookkeeping, not an interface other code can use.
 * Anything reachable from outside its module, or of unknown origin, is not internal.
 */
function isInternalStorage(
  type: ts.Type,
  receiver: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  if (!isBuiltInContainer(type)) return false;

  const target = ts.isPropertyAccessExpression(receiver) ? receiver.name : receiver;
  if (!ts.isIdentifier(target) && !ts.isPrivateIdentifier(target)) return false;

  const declaration = checker.getSymbolAtLocation(target)?.valueDeclaration;
  return declaration !== undefined && isPrivateStorage(declaration);
}

function isBuiltInContainer(type: ts.Type): boolean {
  const declarations = type.getSymbol()?.getDeclarations() ?? [];
  return declarations.length > 0 && declarations.every((d) => d.getSourceFile().hasNoDefaultLib);
}

function isPrivateStorage(declaration: ts.Declaration): boolean {
  if (ts.isVariableDeclaration(declaration)) {
    // Exported only when a module-level `export` statement declares it.
    const statement = declaration.parent?.parent;
    const exported =
      statement !== undefined &&
      ts.isVariableStatement(statement) &&
      ts.isSourceFile(statement.parent) &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    return !exported;
  }
  if (ts.isPropertyDeclaration(declaration)) {
    return (
      ts.isPrivateIdentifier(declaration.name) ||
      hasModifier(declaration, ts.SyntaxKind.PrivateKeyword)
    );
  }
  return false;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []).some(
    (modifier) => modifier.kind === kind,
  );
}
