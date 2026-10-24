/**
 * Rust registry facts (V3 Phase 12.2): maps and tables used as registries.
 * - A local `HashMap` or `BTreeMap`: `insert("k", V)` and `entry("k").or_insert(V)` register V under
 *   "k"; `get` and `contains_key` look "k" up.
 * - A `static` whose initializer builds one local map, as in
 *   `LazyLock::new(|| { let mut m = HashMap::new(); m.insert("k", V); m })`: the inserts register
 *   into the static itself.
 * - A `phf_map!` or `phf_ordered_map!` literal table in a static: each `"k" => V` is a declaration.
 * - A `lazy_static!` block: each `static ref NAME: T = <initializer>` is read as a static.
 * - `get` and `contains_key` on a static registry of the same file look it up.
 * - A bare call of a method the configuration names with a registry, such as `navigate("/users")`
 *   for `routes`, in a function body. A method called on a receiver is not matched.
 *
 * A local map qualifies when one `let` binds it, by its annotation (`HashMap<..>`) or by its
 * constructor (`HashMap::new()`, `with_capacity`), and no other binding in the function reuses its
 * name. A registration needs a repository symbol as its value. A key that is not a literal is
 * dynamic. Struct fields and maps passed in as parameters are not read, and a static used from
 * another file is not matched.
 */
import type {
  RegistryCallFact,
  RegistryDeclarationFact,
  RegistryFact,
  RegistryKeyFact,
} from '../../../facts/types.js';
import { registryRelationshipOf, type RegistryProtocol } from '../../registry-protocols.js';
import { scanTokens, type BodyFact } from '../body.js';
import type { RustToken } from '../lexer.js';
import { blocksOfTokens, factsOutside, ownBodyFacts } from '../nested.js';
import { sourceSpanOf } from '../source-span.js';
import { isTokenGroup, type TokenGroup, type TokenTree } from '../token-tree.js';
import { buildRepo, contextOf, scopeCtx, symbolOf, type Ctx } from './calls.js';
import type { BodyScope, RustCrateIndex, RustModuleNode } from './module-index.js';
import type { RustNameEnvironment } from './resolve.js';
import { pathOfTokens, readPath } from './type-paths.js';

type MethodCall = Extract<BodyFact, { kind: 'method-call' }>;
type CallFact = Extract<BodyFact, { kind: 'call' }>;

const MAP_TYPES: ReadonlySet<string> = new Set(['HashMap', 'BTreeMap']);
const MAP_CONSTRUCTORS: ReadonlySet<string> = new Set(['new', 'with_capacity']);
const PHF_TABLES: ReadonlySet<string> = new Set(['phf_map', 'phf_ordered_map']);
const LOOKUPS: ReadonlySet<string> = new Set(['get', 'contains_key']);

/** Where a map's registrations go: its registry scope, and whether it is internal to its module. */
interface MapLocal {
  readonly scope: string;
  readonly internal: boolean;
}

/** A static's value, or one `static ref` inside a `lazy_static!` block, as a registry source. */
interface StaticSource {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly owner: RustModuleNode;
  readonly crate: RustCrateIndex;
  readonly scopes: readonly BodyScope[];
  readonly tokens: readonly TokenTree[];
}

/** The registry facts of every function body, and of every static that holds a registry. */
export function rustRegistryFacts(
  crates: readonly RustCrateIndex[],
  env: RustNameEnvironment,
  methods: readonly RegistryProtocol[] = [],
): RegistryFact[] {
  const repo = buildRepo(crates, env);
  const facts: RegistryFact[] = [];
  const configured = new Map(
    methods
      .filter((m) => m.registry !== undefined)
      .map((m): [string, RegistryProtocol] => [m.method, m]),
  );
  const statics = staticSourcesOf(crates);
  const unique = uniqueNames(statics);
  const registries = new Map<string, MapLocal>();
  const register = (source: StaticSource, local: MapLocal): void => {
    if (unique.has(nameKey(source.file, source.name))) {
      registries.set(nameKey(source.file, source.name), local);
    }
  };

  // Statics first, so that a function can look up a static registry of its file.
  for (const source of statics) {
    const ctx: Ctx = {
      repo,
      crate: source.crate,
      owner: source.owner,
      self: null,
      bounds: new Map(),
    };
    const local: MapLocal = { scope: source.id, internal: false };
    const table = phfEntriesOf(source.tokens);
    if (table !== undefined) {
      for (const entry of table) {
        const declaration = declarationOf(source, entry, symbolOfValue(entry.value, ctx));
        if (declaration !== undefined) facts.push(declaration);
      }
      register(source, local);
      continue;
    }

    const bodyFacts = factsOutside(scanTokens(source.tokens), blocksOfTokens(source.tokens));
    const maps = mapLocalsOf(bodyFacts, () => local);
    if (maps.size !== 1) continue;
    for (const fact of bodyFacts) {
      if (fact.kind !== 'method-call') continue;
      const site = scopeCtx(ctx, source.scopes, fact.span);
      const call = mapCallOf(fact, maps, site, source.id, source.file, () => undefined);
      if (call !== undefined) facts.push(call);
    }
    register(source, local);
  }

  for (const entry of repo.entries) {
    const body = entry.fn.item.body;
    if (body === null) continue;
    const file = entry.fn.owner.file;
    const bodyFacts = ownBodyFacts(body);
    const maps = mapLocalsOf(bodyFacts, (name) => ({
      scope: `${entry.fn.id}.${name}`,
      internal: true,
    }));
    const ctx = contextOf(repo, entry);
    for (const fact of bodyFacts) {
      if (fact.kind === 'call') {
        const site = scopeCtx(ctx, entry.fn.scopes, fact.span);
        const call = configuredCallOf(fact, configured, site, entry.fn.id, file);
        if (call !== undefined) facts.push(call);
        continue;
      }
      if (fact.kind !== 'method-call') continue;
      const site = scopeCtx(ctx, entry.fn.scopes, fact.span);
      const call = mapCallOf(fact, maps, site, entry.fn.id, file, (name) =>
        registries.get(nameKey(file, name)),
      );
      if (call !== undefined) facts.push(call);
    }
  }
  return facts;
}

function nameKey(file: string, name: string): string {
  return JSON.stringify([file, name]);
}

/** The keys of the statics whose name is unique in their file: a name shared by two is ambiguous. */
function uniqueNames(statics: readonly StaticSource[]): Set<string> {
  const counts = new Map<string, number>();
  for (const source of statics) {
    const key = nameKey(source.file, source.name);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n === 1).map(([key]) => key));
}

/** Every static item and every `lazy_static!` static of the crates. */
function staticSourcesOf(crates: readonly RustCrateIndex[]): StaticSource[] {
  const out: StaticSource[] = [];
  for (const crate of crates) {
    for (const decl of crate.decls) {
      const item = decl.item;
      if (item.kind !== 'static' || item.value === null) continue;
      out.push({
        id: decl.id,
        name: item.name,
        file: decl.owner.file,
        owner: decl.owner,
        crate,
        scopes: decl.scopes,
        tokens: item.value.tokens,
      });
    }
    for (const call of crate.macroCalls) {
      if (call.path[call.path.length - 1] !== 'lazy_static') continue;
      for (const lazy of lazyStaticsOf(call.args.children)) {
        const file = call.owner.file;
        out.push({
          id: `${file}:${lazy.name}`,
          name: lazy.name,
          file,
          owner: call.owner,
          crate,
          scopes: [],
          tokens: lazy.tokens,
        });
      }
    }
  }
  return out;
}

/** The `static [ref] NAME: TYPE = VALUE;` items inside a `lazy_static!` block. */
function lazyStaticsOf(trees: readonly TokenTree[]): Array<{ name: string; tokens: TokenTree[] }> {
  const out: Array<{ name: string; tokens: TokenTree[] }> = [];
  let i = 0;
  while (i < trees.length) {
    if (!isWord(trees[i], 'static')) {
      i += 1;
      continue;
    }
    let j = i + 1;
    if (isWord(trees[j], 'ref')) j += 1;
    const name = trees[j];
    if (name === undefined || isTokenGroup(name) || name.kind !== 'ident') {
      i = j;
      continue;
    }
    j += 1;
    if (!isPunct(trees[j], ':')) {
      i = j;
      continue;
    }
    while (j < trees.length && !isPunct(trees[j], '=')) j += 1;
    if (j >= trees.length) break;
    j += 1;
    const start = j;
    while (j < trees.length && !isPunct(trees[j], ';')) j += 1;
    out.push({ name: name.value, tokens: trees.slice(start, j) });
    i = j + 1;
  }
  return out;
}

function isWord(tree: TokenTree | undefined, word: string): boolean {
  return tree !== undefined && !isTokenGroup(tree) && tree.kind === 'ident' && tree.value === word;
}

function isPunct(tree: TokenTree | undefined, text: string): boolean {
  return tree !== undefined && !isTokenGroup(tree) && tree.kind === 'punct' && tree.text === text;
}

/** One `"k" => V` entry of a `phf` table: its key tokens, its value tokens, and its first token. */
interface TableEntry {
  readonly key: TokenTree[];
  readonly value: TokenTree[];
  readonly head: RustToken;
}

/** The entries of a `phf_map!` or `phf_ordered_map!` invocation, when the value holds one. */
function phfEntriesOf(trees: readonly TokenTree[]): TableEntry[] | undefined {
  for (let i = 0; i + 2 < trees.length; i += 1) {
    const name = trees[i];
    const bang = trees[i + 1];
    const body = trees[i + 2];
    if (name === undefined || isTokenGroup(name) || !PHF_TABLES.has(name.value)) continue;
    if (!isPunct(bang, '!') || body === undefined || !isTokenGroup(body)) continue;
    const out: TableEntry[] = [];
    for (const entry of splitArgs(body)) {
      const arrow = entry.findIndex((t) => isPunct(t, '=>'));
      const head = entry[0];
      if (arrow <= 0 || head === undefined || isTokenGroup(head)) continue;
      out.push({ key: entry.slice(0, arrow), value: entry.slice(arrow + 1), head });
    }
    return out;
  }
  return undefined;
}

function declarationOf(
  source: StaticSource,
  entry: TableEntry,
  target: string | undefined,
): RegistryDeclarationFact | undefined {
  const key = keyOf(entry.key);
  if (target === undefined || key.kind !== 'static') return undefined;
  return {
    kind: 'registry-declaration',
    filePath: source.file,
    span: sourceSpanOf(entry.head, source.file),
    source: 'literal',
    subject: source.name,
    registry: source.id,
    key,
    target,
    targetInGraph: true,
    confidence: 'high',
    evidence: 'ast',
  };
}

/** The map locals of a body: each name bound once, to a map, mapped to its registry. */
function mapLocalsOf(
  facts: readonly BodyFact[],
  registryOf: (name: string) => MapLocal,
): Map<string, MapLocal> {
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

  const maps = new Map<string, MapLocal>();
  for (const fact of facts) {
    if (fact.kind !== 'let' || !fact.simple || fact.bindings.length !== 1) continue;
    const name = fact.bindings[0]?.name;
    if (name === undefined || bindings.get(name) !== 1 || !isMapBinding(fact)) continue;
    maps.set(name, registryOf(name));
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

/**
 * The registry fact of one method call, or undefined for any other call. A map local takes
 * inserts and lookups; a static registry takes lookups only, since a static cannot be written here.
 */
function mapCallOf(
  fact: MethodCall,
  maps: ReadonlyMap<string, MapLocal>,
  site: Ctx,
  owner: string,
  file: string,
  staticNamed: (name: string) => MapLocal | undefined,
): RegistryCallFact | undefined {
  // `map.entry(k).or_insert(v)` registers `v` under `k`.
  const chained = fact.receiverCall;
  if (chained !== undefined && fact.method === 'or_insert' && chained.method === 'entry') {
    const local = maps.get(chained.receiver);
    const [keyTokens] = splitArgs(chained.args);
    const [valueTokens] = splitArgs(fact.args);
    const target = valueTokens === undefined ? undefined : symbolOfValue(valueTokens, site);
    if (local === undefined || target === undefined) return undefined;
    return callFact(fact, file, owner, local, `${chained.receiver}.entry().or_insert`, {
      relationship: 'registers',
      key: keyOf(keyTokens),
      target,
    });
  }

  if (fact.receiver === null) return undefined;
  const subject = `${fact.receiver}.${fact.method}`;
  const local = maps.get(fact.receiver);
  if (local === undefined) {
    const registry = staticNamed(fact.receiver);
    if (registry === undefined || !LOOKUPS.has(fact.method)) return undefined;
    const [keyTokens] = splitArgs(fact.args);
    return callFact(fact, file, owner, registry, subject, {
      relationship: 'resolves',
      key: keyOf(keyTokens),
    });
  }
  const args = splitArgs(fact.args);
  if (fact.method === 'insert') {
    const [keyTokens, valueTokens] = args;
    const target = valueTokens === undefined ? undefined : symbolOfValue(valueTokens, site);
    if (target === undefined) return undefined;
    return callFact(fact, file, owner, local, subject, {
      relationship: 'registers',
      key: keyOf(keyTokens),
      target,
    });
  }
  if (LOOKUPS.has(fact.method)) {
    const [keyTokens] = args;
    return callFact(fact, file, owner, local, subject, {
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
  local: MapLocal,
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
      identity: { kind: 'resolved', scope: local.scope, confidence: 'high' },
      qualifies: true,
      qualificationEvidence: 'ast',
      internal: local.internal,
    },
    key: fields.key,
    ...(fields.target !== undefined ? { target: fields.target } : {}),
  };
}

/**
 * A bare call of a configured method: `navigate("/users")` with `navigate` configured for `routes`.
 * A call whose path has more than one segment, such as `module::navigate(..)`, is not matched.
 */
function configuredCallOf(
  fact: CallFact,
  configured: ReadonlyMap<string, RegistryProtocol>,
  site: Ctx,
  owner: string,
  file: string,
): RegistryCallFact | undefined {
  const [name] = fact.path;
  if (fact.path.length !== 1 || name === undefined) return undefined;
  const protocol = configured.get(name);
  if (protocol?.registry === undefined) return undefined;
  const args = splitArgs(fact.args);
  let target: string | undefined;
  if (protocol.direction === 'register') {
    const valueTokens = protocol.valueArg === undefined ? undefined : args[protocol.valueArg];
    if (valueTokens === undefined) return undefined;
    target = symbolOfValue(valueTokens, site);
    if (target === undefined) return undefined;
  }
  return {
    kind: 'registry-call',
    filePath: file,
    span: sourceSpanOf(fact.span, file),
    owner,
    subject: name,
    assignment: false,
    relationship: registryRelationshipOf(protocol.direction),
    protocolSource: 'config',
    configuredReceiver: true,
    receiver: {
      identity: { kind: 'resolved', scope: protocol.registry, confidence: 'high' },
      qualifies: true,
      qualificationEvidence: 'config',
      internal: false,
    },
    key: keyOf(args[protocol.keyArg ?? 0]),
    ...(target !== undefined ? { target } : {}),
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
