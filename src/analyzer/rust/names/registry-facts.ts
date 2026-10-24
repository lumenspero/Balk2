/**
 * Rust registry facts (V3 Phase 12.2): a local `HashMap` or `BTreeMap` used as a registry.
 * - `map.insert("k", Value)` registers `Value` under `k`.
 * - `map.entry("k").or_insert(Value)` registers `Value` under `k`.
 * - `map.get("k")` and `map.contains_key("k")` look `k` up.
 *
 * A map qualifies when one `let` binds it, by its annotation (`HashMap<..>`) or by its constructor
 * (`HashMap::new()`, `with_capacity`), and no other binding in the function reuses its name. A
 * registration needs a repository symbol as its value. A key that is not a literal is dynamic.
 * Statics, struct fields and maps passed in as parameters are not read in this phase.
 */
import type { RegistryCallFact, RegistryFact, RegistryKeyFact } from '../../../facts/types.js';
import type { BodyFact } from '../body.js';
import type { RustToken } from '../lexer.js';
import { ownBodyFacts } from '../nested.js';
import { sourceSpanOf } from '../source-span.js';
import { isTokenGroup, type TokenGroup, type TokenTree } from '../token-tree.js';
import { buildRepo, contextOf, scopeCtx, symbolOf, type Ctx } from './calls.js';
import type { RustCrateIndex } from './module-index.js';
import type { RustNameEnvironment } from './resolve.js';
import { pathOfTokens, readPath } from './type-paths.js';

type MethodCall = Extract<BodyFact, { kind: 'method-call' }>;

const MAP_TYPES: ReadonlySet<string> = new Set(['HashMap', 'BTreeMap']);
const MAP_CONSTRUCTORS: ReadonlySet<string> = new Set(['new', 'with_capacity']);

/** The registry facts of every function body in the crates. */
export function rustRegistryFacts(
  crates: readonly RustCrateIndex[],
  env: RustNameEnvironment,
): RegistryFact[] {
  const repo = buildRepo(crates, env);
  const facts: RegistryFact[] = [];
  for (const entry of repo.entries) {
    const body = entry.fn.item.body;
    if (body === null) continue;
    const bodyFacts = ownBodyFacts(body);
    const maps = mapLocalsOf(bodyFacts, entry.fn.id);
    if (maps.size === 0) continue;
    const ctx = contextOf(repo, entry);
    for (const fact of bodyFacts) {
      if (fact.kind !== 'method-call') continue;
      const site = scopeCtx(ctx, entry.fn.scopes, fact.span);
      const call = mapCallOf(fact, maps, site, entry.fn.id, entry.fn.owner.file);
      if (call !== undefined) facts.push(call);
    }
  }
  return facts;
}

/** The map locals of a body: each name bound once, to a map, mapped to its registry scope. */
function mapLocalsOf(facts: readonly BodyFact[], fnId: string): Map<string, string> {
  const bindings = new Map<string, number>();
  const count = (name: string): void => {
    bindings.set(name, (bindings.get(name) ?? 0) + 1);
  };
  for (const fact of facts) {
    if (fact.kind === 'let' || fact.kind === 'for' || fact.kind === 'match-arm') {
      for (const binding of fact.bindings) count(binding.name);
    } else if (fact.kind === 'closure') {
      for (const param of fact.params) count(param.name);
    }
  }

  const maps = new Map<string, string>();
  for (const fact of facts) {
    if (fact.kind !== 'let' || !fact.simple || fact.bindings.length !== 1) continue;
    const name = fact.bindings[0]?.name;
    if (name === undefined || bindings.get(name) !== 1 || !isMapBinding(fact)) continue;
    maps.set(name, `${fnId}.${name}`);
  }
  return maps;
}

function isMapBinding(fact: Extract<BodyFact, { kind: 'let' }>): boolean {
  if (fact.type !== null) {
    const segments = readPath(fact.type.tokens).path?.segments ?? [];
    return MAP_TYPES.has(segments[segments.length - 1] ?? '');
  }
  if (fact.init === null) return false;
  const segments = readPath(fact.init).path?.segments ?? [];
  if (segments.length < 2) return false;
  return (
    MAP_TYPES.has(segments[segments.length - 2] ?? '') &&
    MAP_CONSTRUCTORS.has(segments[segments.length - 1] ?? '')
  );
}

/** The registry fact of one method call on a map local, or undefined for any other call. */
function mapCallOf(
  fact: MethodCall,
  maps: ReadonlyMap<string, string>,
  site: Ctx,
  owner: string,
  file: string,
): RegistryCallFact | undefined {
  // `map.entry(k).or_insert(v)` registers `v` under `k`.
  const chained = fact.receiverCall;
  if (chained !== undefined && fact.method === 'or_insert' && chained.method === 'entry') {
    const scope = maps.get(chained.receiver);
    const [keyTokens] = splitArgs(chained.args);
    const [valueTokens] = splitArgs(fact.args);
    const target = valueTokens === undefined ? undefined : symbolOfValue(valueTokens, site);
    if (scope === undefined || target === undefined) return undefined;
    return callFact(fact, file, owner, scope, `${chained.receiver}.entry().or_insert`, {
      relationship: 'registers',
      key: keyOf(keyTokens),
      target,
    });
  }

  if (fact.receiver === null) return undefined;
  const scope = maps.get(fact.receiver);
  if (scope === undefined) return undefined;
  const args = splitArgs(fact.args);
  const subject = `${fact.receiver}.${fact.method}`;
  if (fact.method === 'insert') {
    const [keyTokens, valueTokens] = args;
    const target = valueTokens === undefined ? undefined : symbolOfValue(valueTokens, site);
    if (target === undefined) return undefined;
    return callFact(fact, file, owner, scope, subject, {
      relationship: 'registers',
      key: keyOf(keyTokens),
      target,
    });
  }
  if (fact.method === 'get' || fact.method === 'contains_key') {
    const [keyTokens] = args;
    return callFact(fact, file, owner, scope, subject, {
      relationship: 'resolves',
      key: keyOf(keyTokens),
    });
  }
  return undefined;
}

function callFact(
  fact: MethodCall,
  file: string,
  owner: string,
  scope: string,
  subject: string,
  fields: {
    readonly relationship: 'registers' | 'resolves';
    readonly key: RegistryKeyFact;
    readonly target?: string;
  },
): RegistryCallFact {
  return {
    kind: 'registry-call',
    filePath: file,
    span: sourceSpanOf(fact.span, file),
    owner,
    subject,
    assignment: false,
    relationship: fields.relationship,
    protocolSource: 'built-in',
    configuredReceiver: false,
    receiver: {
      identity: { kind: 'resolved', scope, confidence: 'high' },
      qualifies: true,
      qualificationEvidence: 'ast',
      internal: true,
    },
    key: fields.key,
    ...(fields.target !== undefined ? { target: fields.target } : {}),
  };
}

/** The comma-separated arguments of a call, each as its tokens. */
function splitArgs(group: TokenGroup): TokenTree[][] {
  const args: TokenTree[][] = [];
  let current: TokenTree[] = [];
  for (const child of group.children) {
    if (!isTokenGroup(child) && child.kind === 'punct' && child.text === ',') {
      if (current.length > 0) args.push(current);
      current = [];
    } else {
      current.push(child);
    }
  }
  if (current.length > 0) args.push(current);
  return args;
}

/** A key: a plain string or an integer literal is static; any other expression is dynamic. */
function keyOf(tokens: readonly TokenTree[] | undefined): RegistryKeyFact {
  if (tokens === undefined || tokens.length === 0) return { kind: 'not-a-name' };
  const [only] = tokens;
  if (tokens.length === 1 && only !== undefined && !isTokenGroup(only)) {
    const literal: RustToken = only;
    if (literal.kind === 'str') {
      const text = /^"(.*)"$/.exec(literal.text);
      if (text !== null) {
        return {
          kind: 'static',
          name: text[1] ?? '',
          keyType: 'string',
          numericLiteral: false,
          evidence: 'ast',
        };
      }
    }
    if (literal.kind === 'int') {
      return {
        kind: 'static',
        name: literal.text,
        keyType: 'number',
        numericLiteral: true,
        evidence: 'ast',
      };
    }
  }
  return { kind: 'dynamic', reason: 'key is not a literal' };
}

/** The repository symbol a value expression names, as a type or a value. */
function symbolOfValue(tokens: readonly TokenTree[], site: Ctx): string | undefined {
  const path = pathOfTokens(tokens);
  if (path === null) return undefined;
  return (
    symbolOf(path, 'type', site.owner, site.crate, site.repo.env) ??
    symbolOf(path, 'value', site.owner, site.crate, site.repo.env)
  );
}
