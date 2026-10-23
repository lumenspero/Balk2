/**
 * Python registry facts (V3 Phase 12.2). Reads the registries a program uses:
 * - dictionaries: literal-key stores and loads, `.get` lookups, and module-level displays that map
 *   literal keys to repository symbols;
 * - repository classes that declare a `register` method and a lookup method (`get`, `resolve`,
 *   `create` or `load`): `register('k', Cls)` calls, lookups, and `@registry.register('k')`
 *   decorators above a definition.
 * The registry engine turns the facts into keys and edges, as it does for JS/TS.
 *
 * A store or registration is a fact only when its value is a repository symbol. A non-literal key
 * is dynamic, and the engine reports it only when the registry is trusted.
 *
 * Not yet read: receivers that are not plain names (`self.REGISTRY`), `setdefault` and `update`,
 * parameter-name injection, and attribute registrations.
 */
import type { Expr } from './ast.js';
import type {
  CallContext,
  CallObserver,
  ObservedCall,
  ObservedDecorator,
  ObservedDictAssign,
  ObservedFunction,
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
  RegistryInjectionFact,
  RegistryKeyFact,
  RegistryReceiverFact,
} from '../../facts/types.js';
import type { RegistryRelationship } from '../../types.js';
import type { RegistryNameInjectionRule } from '../registry-protocols.js';
import { dottedName } from './expression-format.js';

/** The collector: its observer feeds one walk, and `facts()` returns the facts it read. */
export interface PythonRegistryCollector {
  readonly observer: CallObserver;
  facts(): RegistryFact[];
}

const BUILTIN_DICT = 'builtins.dict';

/** Methods that look a key up on a repository registry, as the JS/TS catalog has them. */
const REPO_LOOKUPS: readonly string[] = ['get', 'resolve', 'create', 'load'];

/** A receiver the call pass types as a dictionary, with the registry scope its name names. */
interface DictReceiver {
  readonly scope: string;
  readonly receiver: RegistryReceiverFact;
}

export function createPythonRegistryCollector(
  nameInjection: readonly RegistryNameInjectionRule[] = [],
): PythonRegistryCollector {
  const declarations: RegistryDeclarationFact[] = [];
  const calls: RegistryCallFact[] = [];
  const injections: RegistryInjectionFact[] = [];

  const observer: CallObserver = {
    onCall: (site) => {
      const lookup = lookupOf(site) ?? registerOf(site);
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
    onDecorator: (site) => {
      const declaration = decoratorOf(site);
      if (declaration !== undefined) declarations.push(declaration);
    },
    onFunction: (site) => {
      for (const rule of nameInjection) {
        const declaration = fixtureDeclarationOf(site, rule);
        if (declaration !== undefined) declarations.push(declaration);
        injections.push(...parameterInjectionsOf(site, rule));
      }
    },
    onDictAssign: (site) => {
      declarations.push(...declarationsOf(site));
    },
  };
  return {
    observer,
    facts: (): RegistryFact[] => {
      // A parameter is injected only when its registry declares a key of its name.
      const declared = new Set(
        declarations.flatMap((d) =>
          d.key.kind === 'static' ? [registryKey(d.registry, d.key.name)] : [],
        ),
      );
      const injected = injections.filter(
        (i) => i.key.kind === 'static' && declared.has(registryKey(i.registry, i.key.name)),
      );
      return [...declarations, ...injected, ...calls];
    },
  };
}

/** A lookup: `REGISTRY.get('key')` on a dictionary, or a lookup method on a repository registry. */
function lookupOf(site: ObservedCall): RegistryCallFact | undefined {
  const { func, args } = site.call;
  if (func.kind !== 'attribute') return undefined;
  const first = args[0];
  if (first?.kind !== 'positional') return undefined;
  const registry =
    (func.attr === 'get' ? dictReceiver(func.value, site) : undefined) ??
    (REPO_LOOKUPS.includes(func.attr) ? repoRegistry(func.value, site) : undefined);
  if (registry === undefined) return undefined;
  return callFact(site, site.call, site.owner, registry, {
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

/** `registry.register('key', Cls)` on a repository registry, with a repository symbol as the value. */
function registerOf(site: ObservedCall): RegistryCallFact | undefined {
  const { func, args } = site.call;
  if (func.kind !== 'attribute' || func.attr !== 'register') return undefined;
  const keyArg = args[0];
  const valueArg = args[1];
  if (keyArg?.kind !== 'positional' || valueArg?.kind !== 'positional') return undefined;
  const registry = repoRegistry(func.value, site);
  const target = symbolOf(valueArg.value, site);
  if (registry === undefined || target === undefined) return undefined;
  return callFact(site, site.call, site.owner, registry, {
    relationship: 'registers',
    assignment: false,
    key: keyOf(keyArg.value),
    target,
  });
}

/** `@registry.register('key')` above a definition: the definition is registered under the key. */
function decoratorOf(site: ObservedDecorator): RegistryDeclarationFact | undefined {
  const { decorator } = site;
  if (decorator.kind !== 'call') return undefined;
  const func = decorator.func;
  if (func.kind !== 'attribute' || func.attr !== 'register') return undefined;
  const keyArg = decorator.args[0];
  if (keyArg?.kind !== 'positional') return undefined;
  const registry = repoRegistry(func.value, site);
  const key = keyOf(keyArg.value);
  if (registry === undefined || key.kind !== 'static' || !site.declared.has(site.decoratedId)) {
    return undefined;
  }
  return {
    kind: 'registry-declaration',
    filePath: site.info.filePath,
    span: toSourceSpan(decorator.span, site.info.filePath),
    source: 'decorator',
    subject: subjectOf(decorator),
    registry: registry.scope,
    key,
    target: site.decoratedId,
    targetInGraph: true,
    confidence: 'high',
    evidence: 'ast',
  };
}

/**
 * The receiver as a repository registry: a name typed as a repository class that declares
 * `register` and one of the lookup methods. A registry object's storage is not internal.
 */
function repoRegistry(value: Expr, site: CallContext): DictReceiver | undefined {
  if (value.kind !== 'name') return undefined;
  const typed = localTypeOf(value, site.info, site.index);
  if (typed === undefined || typed.name.kind !== 'symbol') return undefined;
  const cls = typed.name.id;
  if (!site.declared.has(`${cls}.register`)) return undefined;
  if (!REPO_LOOKUPS.some((method) => site.declared.has(`${cls}.${method}`))) return undefined;
  const scope = identityOf(value, site.info);
  if (scope === undefined) return undefined;
  return {
    scope,
    receiver: {
      identity: { kind: 'resolved', scope, confidence: 'high' },
      qualifies: true,
      qualificationEvidence: 'ast',
      internal: false,
    },
  };
}

function registryKey(registry: string, name: string): string {
  return JSON.stringify([registry, name]);
}

/** A function decorated with the rule's decorator is declared in the rule's registry under its name. */
function fixtureDeclarationOf(
  site: ObservedFunction,
  rule: RegistryNameInjectionRule,
): RegistryDeclarationFact | undefined {
  const decorated = site.def.decorators.some(
    (d) => dottedName(d.kind === 'call' ? d.func : d) === rule.decorator,
  );
  if (!decorated || !site.declared.has(site.id)) return undefined;
  return {
    kind: 'registry-declaration',
    filePath: site.info.filePath,
    span: toSourceSpan(site.def.span, site.info.filePath),
    source: 'decorator',
    subject: `@${rule.decorator}`,
    registry: rule.registry,
    key: {
      kind: 'static',
      name: site.def.name,
      keyType: 'string',
      numericLiteral: false,
      evidence: 'config',
    },
    target: site.id,
    targetInGraph: true,
    confidence: 'high',
    evidence: 'config',
  };
}

/** Each named parameter of a function asks its registry for the key of its own name. */
function parameterInjectionsOf(
  site: ObservedFunction,
  rule: RegistryNameInjectionRule,
): RegistryInjectionFact[] {
  const out: RegistryInjectionFact[] = [];
  for (const param of site.def.params) {
    if (param.kind !== 'normal' || param.name === null) continue;
    if (param.name === 'self' || param.name === 'cls') continue;
    out.push({
      kind: 'registry-injection',
      filePath: site.info.filePath,
      span: toSourceSpan(param.span, site.info.filePath),
      owner: site.id,
      registry: rule.registry,
      key: {
        kind: 'static',
        name: param.name,
        keyType: 'string',
        numericLiteral: false,
        evidence: 'config',
      },
      subject: param.name,
      mechanism: 'parameter-name',
    });
  }
  return out;
}
