import * as ts from 'typescript';
import type { ConnectionGraph } from '../graph.js';
import type {
  Evidence,
  RegistryKeyNode,
  RegistryRelationship,
  SourceSpan,
  UnresolvedReason,
} from '../types.js';
import { enclosingOwner } from './owner.js';
import { createPathLookup } from './repository-files.js';
import type { RepositoryProgram } from './repository-program.js';
import { ReceiverResolver } from './receiver-identity.js';
import { resolveRegistryKey, type RegistryKeyResolution } from './registry-keys.js';
import {
  RegistryProtocolCatalog,
  type RegistryProtocolOptions,
  type ResolvedRegistryProtocol,
} from './registry-protocols.js';
import { qualifyRegistryReceiver } from './registry-receivers.js';
import { snippetOf, spanOf } from './spans.js';
import { symbolTargetOf } from './registry-targets.js';
import { declareRegistrations } from './registry-sources.js';
import { unwrapExpression } from './static-keys.js';

/** `registry[key] = value`: a registration by assignment, on a dictionary only. */
const ASSIGNMENT: ResolvedRegistryProtocol = {
  method: '[]=',
  direction: 'register',
  relationship: 'registers',
  keyArg: 0,
  valueArg: 1,
  receiver: 'registry-like',
  source: 'built-in',
};

/** A lookup whose key node is known; joined to registrations once every file is read. */
interface Lookup {
  readonly registryKey: RegistryKeyNode;
  readonly owner: string;
  readonly span: SourceSpan;
  readonly subject: string;
  readonly relationship: RegistryRelationship;
}

interface RegistryCall {
  readonly filePath: string;
  /** The call expression, or the assignment expression */
  readonly node: ts.Expression;
  readonly receiver: ts.Expression;
  readonly keyExpression: ts.Expression;
  readonly valueExpression: ts.Expression | undefined;
  readonly protocol: ResolvedRegistryProtocol;
  readonly assignment: boolean;
}

/**
 * Registry pass: map registry calls (`container.set('user', User)`, `container.get('user')`,
 * `router.navigate('/users')`) and dictionary assignments (`handlers[404] = NotFound`) onto
 * registry keys.
 *
 * A registration links the key to the symbol it maps to with `registers`. A lookup links its
 * caller to the key with `resolves` or `routesTo`. A key is scoped by the identity of its registry,
 * so the same name in two registries stays two keys. A dynamic key, or a receiver whose identity
 * cannot be read, becomes an unresolved observation rather than a guessed edge.
 *
 * Runs after the per-file pass, so the symbols a registration maps to already exist in the graph.
 */
export function collectRegistryRelationships(
  repository: RepositoryProgram,
  graph: ConnectionGraph,
  options: RegistryProtocolOptions = {},
): void {
  const catalog = new RegistryProtocolCatalog(options);
  const receivers = new ReceiverResolver(repository);
  const checker = repository.checker;
  const pathOf = createPathLookup(repository);
  // Every key a registry declares (by a register call or assignment), by id.
  const declared = new Map<string, RegistryKeyNode>();
  const lookups: Lookup[] = [];
  declareRegistrations(repository, graph, catalog, options, declared);

  for (const call of collectRegistryCalls(repository, catalog)) {
    const { filePath, node, receiver, protocol } = call;

    // A registration by assignment needs a known value. Otherwise `env['X'] = 'y'` on any
    // dictionary would become a key.
    const target = call.valueExpression
      ? symbolTargetOf(call.valueExpression, checker, graph, pathOf)
      : undefined;
    if (call.assignment && target === undefined) continue;

    const qualification = qualifyRegistryReceiver(protocol.receiver, receiver, catalog, checker);
    if (!qualification.qualifies) continue;

    const key = resolveRegistryKey(call.keyExpression, checker, qualification.container);
    if (key.kind === 'not-a-name') continue;

    const span = spanOf(node, filePath);
    const owner = enclosingOwner(node, filePath);
    const identity = receivers.resolve(receiver);

    const observe = (reason: UnresolvedReason, detail: string): void => {
      const unresolved = graph.addUnresolved({
        reason,
        attempted: protocol.relationship,
        subject: snippetOf(node),
        location: span,
        detail,
      });
      graph.addRelationship(protocol.relationship, owner, unresolved.id, 'low', {
        evidence: 'ts-program',
        spans: [span],
      });
    };

    if (key.kind === 'dynamic') {
      observe('dynamic-registry-key', key.reason);
      continue;
    }

    if (identity.kind === 'unknown') {
      observe('unknown-registry-receiver', identity.reason);
      continue;
    }

    const registryKey = graph.addRegistryKey(key.name, identity.scope, key.keyType);
    const evidence = evidenceOf(protocol, qualification.evidence, key);
    const confidence = identity.confidence === 'high' ? 'high' : 'medium';

    if (protocol.relationship === 'registers') {
      declared.set(registryKey.id, registryKey);
      if (target !== undefined) {
        graph.addRelationship('registers', registryKey.id, target, confidence, {
          evidence,
          spans: [span],
        });
      }
      continue;
    }

    graph.addRelationship(protocol.relationship, owner, registryKey.id, confidence, {
      evidence,
      spans: [span],
    });
    lookups.push({
      registryKey,
      owner,
      span,
      subject: snippetOf(node),
      relationship: protocol.relationship,
    });
  }

  recordAmbiguousLookups(graph, lookups, declared);
}

/**
 * Agreement: a lookup reaches a registration when its registry identity and key both match, which
 * is what sharing one key node means, so those lookups need nothing more.
 *
 * A lookup that disagrees is recorded as ambiguous only when its registry is one we can see into
 * (it declares other keys) and it does not declare this key, while another registry does. The
 * observation lists those candidates instead of choosing one. A lookup into a registry we know
 * nothing about is left alone, so incidental `get('user')` calls on unrelated maps are not flagged.
 */
function recordAmbiguousLookups(
  graph: ConnectionGraph,
  lookups: readonly Lookup[],
  declared: ReadonlyMap<string, RegistryKeyNode>,
): void {
  const declaredScopes = new Set([...declared.values()].map((node) => node.scope));
  const candidatesByKey = new Map<string, string[]>();
  for (const node of declared.values()) {
    const group = keyGroup(node);
    candidatesByKey.set(group, [...(candidatesByKey.get(group) ?? []), node.id]);
  }

  for (const lookup of lookups) {
    const { registryKey } = lookup;
    if (declared.has(registryKey.id)) continue;
    if (!declaredScopes.has(registryKey.scope)) continue;

    const candidates = candidatesByKey.get(keyGroup(registryKey)) ?? [];
    if (candidates.length === 0) continue;

    const unresolved = graph.addUnresolved({
      reason: 'ambiguous-registry',
      attempted: lookup.relationship,
      subject: lookup.subject,
      location: lookup.span,
      candidates,
      detail: `"${registryKey.key}" is not declared in this registry, but ${candidates.length} other ${candidates.length === 1 ? 'registry declares it' : 'registries declare it'}`,
    });
    graph.addRelationship(lookup.relationship, lookup.owner, unresolved.id, 'low', {
      evidence: 'ts-program',
      spans: [lookup.span],
    });
  }
}

/** Keys agree only when both their type and their text agree. */
function keyGroup(node: RegistryKeyNode): string {
  return `${node.keyType}:${node.key}`;
}

/**
 * Every call whose method has a registry protocol, and every dictionary assignment, in a stable
 * order. Receivers are checked later, because most method names match nothing.
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
        const keyExpression = protocol ? node.arguments[protocol.keyArg] : undefined;
        if (protocol && receiver && keyExpression) {
          found.push({
            filePath,
            node,
            receiver,
            keyExpression,
            valueExpression:
              protocol.valueArg !== undefined ? node.arguments[protocol.valueArg] : undefined,
            protocol,
            assignment: false,
          });
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

/** `config` when a configured protocol or rule decided it; otherwise what the compiler saw. */
function evidenceOf(
  protocol: ResolvedRegistryProtocol,
  qualification: Evidence,
  key: Extract<RegistryKeyResolution, { kind: 'static' }>,
): Evidence {
  if (protocol.source === 'config') return 'config';
  if (key.via === 'numeric-literal') return key.evidence;
  return qualification;
}
