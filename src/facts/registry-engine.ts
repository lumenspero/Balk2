import { normalizePath, registryKeyId } from '../graph.js';
import type {
  Confidence,
  Evidence,
  RegistryKeyType,
  RegistryRelationship,
  SourceSpan,
  UnresolvedReason,
} from '../types.js';
import type {
  RegistryCallFact,
  RegistryConfiguredKey,
  RegistryFact,
  RegistryKeyFact,
} from './types.js';

/**
 * The registry engine (Phase 2.7, registries). It reads registry facts and returns edge
 * descriptions. It never touches the graph.
 *
 * A registration links a key to the symbol it maps to. A lookup links its caller to the key. A
 * dynamic key, or a receiver whose identity cannot be read, is an observation, and only when the
 * receiver is trusted as a registry. A lookup that names a key another registry declares, while
 * its own registry declares other keys, is ambiguous.
 */

/** One registry edge to write, in the order the engine found it. */
export type RegistryEdge =
  | {
      readonly kind: 'declare';
      readonly registry: string;
      readonly key: string;
      readonly keyType: RegistryKeyType;
      readonly target?: string;
      readonly confidence: Confidence;
      readonly evidence: Evidence;
    }
  | {
      readonly kind: 'inject';
      readonly owner: string;
      readonly registry: string;
      readonly key: string;
      readonly keyType: RegistryKeyType;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: 'use';
      readonly registry: string;
      readonly key: string;
      readonly keyType: RegistryKeyType;
      readonly relationship: RegistryRelationship;
      readonly from: string;
      /** For `registers` only: the symbol the key maps to. */
      readonly target?: string;
      readonly confidence: Confidence;
      readonly evidence: Evidence;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: 'observe';
      readonly relationship: RegistryRelationship;
      readonly from: string;
      readonly reason: UnresolvedReason;
      readonly subject: string;
      readonly detail: string;
      readonly span: SourceSpan;
      readonly tier?: 'internal';
    }
  | {
      readonly kind: 'ambiguous';
      readonly relationship: RegistryRelationship;
      readonly from: string;
      readonly subject: string;
      readonly span: SourceSpan;
      /** Ids of the keys the lookup could have meant. */
      readonly candidates: readonly string[];
      readonly detail: string;
    };

/** A key the engine has seen declared. `registry` is the scope as the graph normalizes it. */
interface DeclaredKey {
  readonly registry: string;
  readonly key: string;
  readonly keyType: RegistryKeyType;
}

/** A lookup, held until every declaration is known. */
interface Lookup {
  readonly relationship: RegistryRelationship;
  readonly from: string;
  readonly subject: string;
  readonly span: SourceSpan;
  readonly registry: string;
  readonly key: string;
  readonly keyType: RegistryKeyType;
}

type StaticKey = Extract<RegistryKeyFact, { readonly kind: 'static' }>;

/**
 * Runs the registry engine. `configured` holds manifest entries then discovered files. `facts`
 * holds declarations, then injections, then calls, each in source order.
 */
export function runRegistryEngine(input: {
  readonly configured: readonly RegistryConfiguredKey[];
  readonly facts: readonly RegistryFact[];
}): RegistryEdge[] {
  const edges: RegistryEdge[] = [];
  const declared = new Map<string, DeclaredKey>();

  const declare = (
    registry: string,
    key: string,
    keyType: RegistryKeyType,
    target: string | undefined,
    confidence: Confidence,
    evidence: Evidence,
  ): void => {
    edges.push({
      kind: 'declare',
      registry,
      key,
      keyType,
      ...(target !== undefined ? { target } : {}),
      confidence,
      evidence,
    });
    remember(declared, registry, key, keyType);
  };

  for (const entry of input.configured) {
    declare(entry.registry, entry.key, 'string', entry.target, 'high', 'config');
  }

  for (const fact of ofKind(input.facts, 'registry-declaration')) {
    if (fact.key.kind === 'dynamic') {
      edges.push(
        observation(
          'registers',
          fact.target,
          'dynamic-registry-key',
          fact.subject,
          fact.key.reason,
          fact.span,
        ),
      );
    } else if (fact.key.kind === 'static') {
      declare(
        fact.registry,
        fact.key.name,
        fact.key.keyType,
        fact.targetInGraph ? fact.target : undefined,
        fact.confidence,
        fact.evidence,
      );
    }
  }

  for (const fact of ofKind(input.facts, 'registry-injection')) {
    if (fact.key.kind === 'dynamic') {
      edges.push(
        observation(
          'resolves',
          fact.owner,
          'dynamic-registry-key',
          fact.subject,
          fact.key.reason,
          fact.span,
        ),
      );
    } else if (fact.key.kind === 'static') {
      edges.push({
        kind: 'inject',
        owner: fact.owner,
        registry: fact.registry,
        key: fact.key.name,
        keyType: fact.key.keyType,
        span: fact.span,
      });
    }
  }

  const calls = ofKind(input.facts, 'registry-call');

  // A registry is one that already declares a key, or receives a symbol-valued registration.
  const registryScopes = new Set<string>([...declared.values()].map((entry) => entry.registry));
  for (const call of calls) {
    if (
      call.relationship === 'registers' &&
      call.target !== undefined &&
      call.receiver.identity.kind === 'resolved'
    ) {
      registryScopes.add(call.receiver.identity.scope);
    }
  }

  const lookups: Lookup[] = [];
  for (const call of calls) {
    const key = call.key;
    const identity = call.receiver.identity;
    // A registration by assignment needs a known value. Otherwise `env['X'] = 'y'` on any
    // dictionary would become a key.
    if (call.assignment && call.target === undefined) continue;
    if (!call.receiver.qualifies) continue;
    if (key.kind === 'not-a-name') continue;

    // Trusted: a configured rule, a receiver qualified by configuration, or a registry with
    // evidence of repository symbols. An untrusted receiver may still form edges from static keys,
    // but produces no observations.
    const trusted =
      call.configuredReceiver ||
      call.receiver.qualificationEvidence === 'config' ||
      (identity.kind === 'resolved' && registryScopes.has(identity.scope));

    if (key.kind === 'dynamic') {
      if (trusted) {
        edges.push(
          observation(
            call.relationship,
            call.owner,
            'dynamic-registry-key',
            call.subject,
            key.reason,
            call.span,
            call.receiver.internal ? 'internal' : undefined,
          ),
        );
      }
      continue;
    }

    if (identity.kind === 'unknown') {
      if (trusted) {
        edges.push(
          observation(
            call.relationship,
            call.owner,
            'unknown-registry-receiver',
            call.subject,
            identity.reason,
            call.span,
          ),
        );
      }
      continue;
    }

    const confidence: Confidence = identity.confidence === 'high' ? 'high' : 'medium';
    const evidence = evidenceOf(call, key);

    if (call.relationship === 'registers') {
      remember(declared, identity.scope, key.name, key.keyType);
      edges.push({
        kind: 'use',
        registry: identity.scope,
        key: key.name,
        keyType: key.keyType,
        relationship: 'registers',
        from: call.owner,
        ...(call.target !== undefined ? { target: call.target } : {}),
        confidence,
        evidence,
        span: call.span,
      });
      continue;
    }

    edges.push({
      kind: 'use',
      registry: identity.scope,
      key: key.name,
      keyType: key.keyType,
      relationship: call.relationship,
      from: call.owner,
      confidence,
      evidence,
      span: call.span,
    });
    lookups.push({
      relationship: call.relationship,
      from: call.owner,
      subject: call.subject,
      span: call.span,
      registry: normalizePath(identity.scope),
      key: key.name,
      keyType: key.keyType,
    });
  }

  edges.push(...ambiguousLookups(lookups, declared));
  return edges;
}

/**
 * Agreement: a lookup reaches a registration when its registry and key both match, which is what
 * one key node means, so those lookups need nothing more.
 *
 * A lookup that disagrees is ambiguous only when its registry is one we can see into (it declares
 * other keys) and does not declare this key, while another registry does. A lookup into a registry
 * we know nothing about is left alone, so incidental `get('user')` calls are not flagged.
 */
function ambiguousLookups(
  lookups: readonly Lookup[],
  declared: ReadonlyMap<string, DeclaredKey>,
): RegistryEdge[] {
  const declaredScopes = new Set([...declared.values()].map((entry) => entry.registry));
  const candidatesByGroup = new Map<string, string[]>();
  for (const [id, entry] of declared) {
    const group = keyGroup(entry.keyType, entry.key);
    candidatesByGroup.set(group, [...(candidatesByGroup.get(group) ?? []), id]);
  }

  const edges: RegistryEdge[] = [];
  for (const lookup of lookups) {
    if (declared.has(registryKeyId(lookup.key, lookup.registry, lookup.keyType))) continue;
    if (!declaredScopes.has(lookup.registry)) continue;

    const candidates = candidatesByGroup.get(keyGroup(lookup.keyType, lookup.key)) ?? [];
    if (candidates.length === 0) continue;

    edges.push({
      kind: 'ambiguous',
      relationship: lookup.relationship,
      from: lookup.from,
      subject: lookup.subject,
      span: lookup.span,
      candidates,
      detail: `"${lookup.key}" is not declared in this registry, but ${candidates.length} other ${candidates.length === 1 ? 'registry declares it' : 'registries declare it'}`,
    });
  }
  return edges;
}

function remember(
  declared: Map<string, DeclaredKey>,
  registry: string,
  key: string,
  keyType: RegistryKeyType,
): void {
  declared.set(registryKeyId(key, registry, keyType), {
    registry: normalizePath(registry),
    key,
    keyType,
  });
}

function observation(
  relationship: RegistryRelationship,
  from: string,
  reason: UnresolvedReason,
  subject: string,
  detail: string,
  span: SourceSpan,
  tier?: 'internal',
): RegistryEdge {
  return {
    kind: 'observe',
    relationship,
    from,
    reason,
    subject,
    detail,
    span,
    ...(tier ? { tier } : {}),
  };
}

/** `config` when a configured protocol decided it; the literal's own evidence for a numeric key. */
function evidenceOf(call: RegistryCallFact, key: StaticKey): Evidence {
  if (call.protocolSource === 'config') return 'config';
  if (key.numericLiteral) return key.evidence;
  return call.receiver.qualificationEvidence;
}

/** Keys agree only when both their type and their text agree. */
function keyGroup(keyType: RegistryKeyType, key: string): string {
  return `${keyType}:${key}`;
}

function ofKind<K extends RegistryFact['kind']>(
  facts: readonly RegistryFact[],
  kind: K,
): Extract<RegistryFact, { readonly kind: K }>[] {
  return facts.filter(
    (fact): fact is Extract<RegistryFact, { readonly kind: K }> => fact.kind === kind,
  );
}
