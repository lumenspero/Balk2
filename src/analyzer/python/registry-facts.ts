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
 * Not yet read: receivers that are not plain names (`self.REGISTRY`), `setdefault` and `update`.
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
import {
  registryRelationshipOf,
  type RegistryAttributeRule,
  type RegistryNameInjectionRule,
  type RegistryProtocol,
} from '../registry-protocols.js';
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

/** The rules a collector reads, from `protocols.registries`. */
export interface PythonRegistryRules {
  readonly nameInjection?: readonly RegistryNameInjectionRule[];
  readonly attributes?: readonly RegistryAttributeRule[];
  /** Methods the configuration names with a registry; only bare calls of them are read. */
  readonly methods?: readonly RegistryProtocol[];
}

export function createPythonRegistryCollector(
  rules: PythonRegistryRules = {},
): PythonRegistryCollector {
  const nameInjection = rules.nameInjection ?? [];
  const attributes = rules.attributes ?? [];
  const methods = (rules.methods ?? []).filter((m) => m.registry !== undefined);
  const declarations: RegistryDeclarationFact[] = [];
  const calls: RegistryCallFact[] = [];
  const injections: RegistryInjectionFact[] = [];

  const observer: CallObserver = {
    onCall: (site) => {
      const lookup = configuredCallOf(site, methods) ?? lookupOf(site) ?? registerOf(site);
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
      declarations.push(...attributeDeclarationsOf(site, attributes));
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

/**
 * A bare call of a method the configuration names with a registry, such as `navigate('/users')`
 * for `routes`. A method called on a receiver is not matched, as in the JS/TS catalog.
 */
function configuredCallOf(
  site: ObservedCall,
  methods: readonly RegistryProtocol[],
): RegistryCallFact | undefined {
  const { func, args } = site.call;
  if (func.kind !== 'name') return undefined;
  const protocol = methods.find((m) => m.method === func.id);
  if (protocol?.registry === undefined) return undefined;
  const keyArg = args[protocol.keyArg ?? 0];
  if (keyArg?.kind !== 'positional') return undefined;
  let target: string | undefined;
  if (protocol.direction === 'register') {
    const valueArg = protocol.valueArg === undefined ? undefined : args[protocol.valueArg];
    if (valueArg?.kind !== 'positional') return undefined;
    target = symbolOf(valueArg.value, site);
    if (target === undefined) return undefined;
  }
  const fact = callFact(site, site.call, site.owner, configuredRegistry(protocol.registry), {
    relationship: registryRelationshipOf(protocol.direction),
    assignment: false,
    key: keyOf(keyArg.value),
    ...(target !== undefined ? { target } : {}),
  });
  return { ...fact, protocolSource: 'config', configuredReceiver: true };
}

/** A registry named by configuration: its identity is the configured name. */
function configuredRegistry(name: string): DictReceiver {
  return {
    scope: name,
    receiver: {
      identity: { kind: 'resolved', scope: name, confidence: 'high' },
      qualifies: true,
      qualificationEvidence: 'config',
      internal: false,
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

/**
 * An attribute rule declares the decorated symbol: under its own name for `fn-name`, or under the
 * literal in the call's argument at `arg`. A bare decorator has no argument, so only `fn-name`
 * applies to it.
 */
function attributeDeclarationsOf(
  site: ObservedDecorator,
  rules: readonly RegistryAttributeRule[],
): RegistryDeclarationFact[] {
  const { decorator } = site;
  const written = dottedName(decorator.kind === 'call' ? decorator.func : decorator);
  if (written === undefined || !site.declared.has(site.decoratedId)) return [];
  const out: RegistryDeclarationFact[] = [];
  for (const rule of rules) {
    if (rule.name !== written) continue;
    const key = keyForAttribute(rule, site);
    if (key === undefined) continue;
    out.push({
      kind: 'registry-declaration',
      filePath: site.info.filePath,
      span: toSourceSpan(decorator.span, site.info.filePath),
      source: 'decorator',
      subject: `@${rule.name}`,
      registry: rule.registry,
      key,
      target: site.decoratedId,
      targetInGraph: true,
      confidence: 'high',
      evidence: 'config',
    });
  }
  return out;
}

function keyForAttribute(
  rule: RegistryAttributeRule,
  site: ObservedDecorator,
): RegistryKeyFact | undefined {
  if (rule.key === 'fn-name') {
    const label = site.decoratedId.slice(site.info.filePath.length + 1);
    const name = label.split('.').pop() ?? label;
    return { kind: 'static', name, keyType: 'string', numericLiteral: false, evidence: 'config' };
  }
  const { decorator } = site;
  if (decorator.kind !== 'call') return undefined;
  const arg = decorator.args[rule.key.arg];
  if (arg?.kind !== 'positional') return undefined;
  const key = keyOf(arg.value);
  return key.kind === 'static' ? key : undefined;
}
