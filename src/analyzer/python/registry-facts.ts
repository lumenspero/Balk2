/**
 * Python registry facts (V3 Phase 12.2). Reads the dictionaries a program uses as registries:
 * literal-key stores and loads, `.get` lookups, and dictionary displays that map literal keys to
 * repository symbols. The registry engine turns them into keys and edges, as it does for JS/TS.
 *
 * A receiver qualifies when the call pass types it as a built-in `dict` (a display or `dict(...)`).
 * A store is a registration only when its value is a repository symbol. Any other store gives no
 * fact. A non-literal key is dynamic, and the engine reports it only when the registry is trusted.
 *
 * Not yet read: receivers that are not plain names (`self.REGISTRY`), `setdefault` and `update`,
 * and repository classes with a `register` method and decorator registrations.
 */
import type { Expr } from './ast.js';
import type {
  CallContext,
  CallObserver,
  ObservedCall,
  ObservedDictAssign,
  ObservedStore,
  ObservedSubscript,
} from './calls.js';
import { resolveBase, toSourceSpan } from './inheritance.js';
import { identityOf, subjectOf } from './receiver-scope.js';
import { localTypeOf, plainStringValue } from './typed-receivers.js';
import type {
  RegistryCallFact,
  RegistryDeclarationFact,
  RegistryFact,
  RegistryKeyFact,
  RegistryReceiverFact,
} from '../../facts/types.js';
import type { RegistryRelationship } from '../../types.js';

/** The collector: its observer feeds one walk, and `facts()` returns the facts it read. */
export interface PythonRegistryCollector {
  readonly observer: CallObserver;
  facts(): RegistryFact[];
}

const BUILTIN_DICT = 'builtins.dict';

/** A receiver the call pass types as a dictionary, with the registry scope its name names. */
interface DictReceiver {
  readonly scope: string;
  readonly receiver: RegistryReceiverFact;
}

export function createPythonRegistryCollector(): PythonRegistryCollector {
  const declarations: RegistryDeclarationFact[] = [];
  const calls: RegistryCallFact[] = [];

  const observer: CallObserver = {
    onCall: (site) => {
      const lookup = lookupOf(site);
      if (lookup !== undefined) calls.push(lookup);
    },
    onSubscript: (site) => {
      const load = loadOf(site);
      if (load !== undefined) calls.push(load);
    },
    onStore: (site) => {
      const store = storeOf(site);
      if (store !== undefined) calls.push(store);
    },
    onDictAssign: (site) => {
      declarations.push(...declarationsOf(site));
    },
  };
  return { observer, facts: () => [...declarations, ...calls] };
}

/** `REGISTRY.get('key')`: a lookup of a literal or dynamic key. */
function lookupOf(site: ObservedCall): RegistryCallFact | undefined {
  const { func, args } = site.call;
  if (func.kind !== 'attribute' || func.attr !== 'get') return undefined;
  const first = args[0];
  if (first?.kind !== 'positional') return undefined;
  const dict = dictReceiver(func.value, site);
  if (dict === undefined) return undefined;
  return callFact(site, site.call, site.owner, dict, {
    relationship: 'resolves',
    assignment: false,
    key: keyOf(first.value),
  });
}

/** `REGISTRY[key]` read: a lookup. */
function loadOf(site: ObservedSubscript): RegistryCallFact | undefined {
  const dict = dictReceiver(site.node.value, site);
  if (dict === undefined) return undefined;
  return callFact(site, site.node, site.owner, dict, {
    relationship: 'resolves',
    assignment: false,
    key: keyOf(site.node.index),
  });
}

/** `REGISTRY[key] = Cls`: a registration, when the stored value is a repository symbol. */
function storeOf(site: ObservedStore): RegistryCallFact | undefined {
  const dict = dictReceiver(site.node.value, site);
  const target = symbolOf(site.value, site);
  if (dict === undefined || target === undefined) return undefined;
  return callFact(site, site.node, site.owner, dict, {
    relationship: 'registers',
    assignment: true,
    key: keyOf(site.node.index),
    target,
  });
}

/** `REGISTRY = {'key': Cls}`: a declaration of each literal key whose value is a repository symbol. */
function declarationsOf(site: ObservedDictAssign): RegistryDeclarationFact[] {
  // Only module-level displays are declared. The scope analysis records no resolution for an
  // assignment target, so a name bound inside a function or class has no identity to declare.
  if (site.owner !== null) return [];
  const out: RegistryDeclarationFact[] = [];
  for (const name of site.targets) {
    if (name.kind !== 'name') continue;
    const scope = `${site.info.filePath}:${name.id}`;
    for (const entry of site.value.entries) {
      if (entry.key === null) continue;
      const key = keyOf(entry.key);
      if (key.kind !== 'static') continue;
      const target = symbolOf(entry.value, site);
      if (target === undefined) continue;
      out.push({
        kind: 'registry-declaration',
        filePath: site.info.filePath,
        span: toSourceSpan(entry.key.span, site.info.filePath),
        source: 'literal',
        subject: subjectOf(name),
        registry: scope,
        key,
        target,
        targetInGraph: true,
        confidence: 'high',
        evidence: 'ast',
      });
    }
  }
  return out;
}

/** The receiver as a dictionary, or undefined when the call pass does not type it so. */
function dictReceiver(value: Expr, site: CallContext): DictReceiver | undefined {
  if (value.kind !== 'name') return undefined;
  const typed = localTypeOf(value, site.info, site.index);
  if (typed === undefined || typed.name.kind !== 'external' || typed.name.name !== BUILTIN_DICT) {
    return undefined;
  }
  const scope = identityOf(value, site.info);
  if (scope === undefined) return undefined;
  return {
    scope,
    receiver: {
      identity: { kind: 'resolved', scope, confidence: 'high' },
      qualifies: true,
      qualificationEvidence: 'ast',
      internal: !isModuleScope(scope, site.info.filePath),
    },
  };
}

/** A module-level identity is `<file>:<name>`; anything with a scope label has a dot after the colon. */
function isModuleScope(scope: string, filePath: string): boolean {
  return !scope.slice(filePath.length + 1).includes('.');
}

/** The repository symbol a value names, when it is declared in the repository. */
function symbolOf(value: Expr, site: CallContext): string | undefined {
  const target = resolveBase(value, site.info, site.ctx, site.declared);
  return target?.kind === 'symbol' && site.declared.has(target.id) ? target.id : undefined;
}

/** A key: a plain string or a number literal is static; any other expression is dynamic. */
function keyOf(index: Expr): RegistryKeyFact {
  if (index.kind === 'tuple' || index.kind === 'slice') return { kind: 'not-a-name' };
  const plain = plainStringValue(index);
  if (plain !== undefined) {
    return {
      kind: 'static',
      name: plain,
      keyType: 'string',
      numericLiteral: false,
      evidence: 'ast',
    };
  }
  if (index.kind === 'constant' && index.type === 'number') {
    return {
      kind: 'static',
      name: index.raw,
      keyType: 'number',
      numericLiteral: true,
      evidence: 'ast',
    };
  }
  if (index.kind === 'constant' && index.type === 'str') {
    return { kind: 'dynamic', reason: 'string literal is not a plain name' };
  }
  return { kind: 'dynamic', reason: 'key is not a literal' };
}

function callFact(
  site: CallContext,
  node: Expr,
  owner: string | null,
  dict: DictReceiver,
  fields: {
    readonly relationship: RegistryRelationship;
    readonly assignment: boolean;
    readonly key: RegistryKeyFact;
    readonly target?: string;
  },
): RegistryCallFact {
  return {
    kind: 'registry-call',
    filePath: site.info.filePath,
    span: toSourceSpan(node.span, site.info.filePath),
    owner: owner ?? site.info.filePath,
    subject: subjectOf(node),
    assignment: fields.assignment,
    relationship: fields.relationship,
    protocolSource: 'built-in',
    configuredReceiver: false,
    receiver: dict.receiver,
    key: fields.key,
    ...(fields.target !== undefined ? { target: fields.target } : {}),
  };
}
