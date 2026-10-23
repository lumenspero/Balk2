/**
 * Rust symbols and owners (V3 Phase 9.1).
 *
 * Declares the named items of one Rust file as `Declaration` facts, and records each module's
 * names in the three namespaces (names/namespaces.ts). The same facts shape as the Python pass
 * (python/symbols.ts), so Rust and Python symbols are read the same way downstream.
 *
 * Declared:
 * - Functions (`function`), constants (`constant`), statics (`variable`), type aliases (`type`).
 * - Structs, unions (as `struct`) and enums (`enum`). A tuple or unit struct also takes a value
 *   name, its constructor.
 * - Traits (`trait`) and inline modules (`module`, `mod x { }`).
 * - `macro_rules!` macros (`macro`), named `m!`.
 * - Functions in an inherent or trait impl, and in a trait body (`method`), named `Type.method`.
 *   A trait impl adds the trait: `Type[Trait].method` (V3 D6). Owners are the type, or the trait.
 * - Items inside an inline module are named `module::item` (V3 naming table).
 * - Items in an `extern` block, as functions and variables.
 *
 * Not declared here (later sub-phases): `use` (9.3), `mod x;` (the module tree, Phase 8), exports
 * (9.4, so `exported` is false), associated consts and types, fields and variants, and any item
 * defined inside a function body or a macro (Phase 10).
 *
 * Duplicates follow the naming rule: a second name in the same scope and namespace gets `#n` by
 * source order. Two definitions in different `cfg` branches are the same symbol instead (twins),
 * so both declarations keep one id and their conditions.
 */
import { blockKey, blocksOfTokens, bodyBlocksOf } from './nested.js';
import type { Declaration, Visibility } from '../../facts/types.js';
import type { SourceSpan, SymbolType } from '../../types.js';
import type {
  Fragment,
  Item,
  RustFile,
  Span,
  Attribute,
  Visibility as RustVisibility,
} from './items.js';
import { isTokenGroup, type TokenTree } from './token-tree.js';
import {
  namespacesOf,
  recordName,
  type RustNamespace,
  type RustNamespaceTables,
} from './names/namespaces.js';

type FnItem = Extract<Item, { kind: 'fn' }>;

/** A function declared in the file, with the impl or trait it sits in, if any (V3 Phase 9.6). */
export interface RustFunction {
  readonly item: FnItem;
  /** The symbol id the function is declared under. */
  readonly id: string;
  /** The `impl` or `trait` item that contains the function, or null for a free function. */
  readonly container: Item | null;
}

export interface RustSymbolAnalysis {
  /** One per definition site. Twins share an id, as `groupSymbols` merges them. */
  readonly declarations: readonly Declaration[];
  /** The namespace tables of every scope in the file. */
  readonly namespaces: RustNamespaceTables;
  /** Every function declared in the file, in source order. */
  readonly functions: readonly RustFunction[];
}

/** Where the items being walked sit. */
interface Scope {
  /** Inline module path with a trailing `::`, or empty at the file root (`tests::`). */
  readonly modulePath: string;
  /** The key of this scope in the namespace tables. */
  readonly key: string;
  /** The `cfg` conditions of every enclosing item, as text, never evaluated. */
  readonly conditions: readonly string[];
}

/** The state shared by one file's walk. */
interface Walk {
  readonly filePath: string;
  readonly declarations: Declaration[];
  readonly functions: RustFunction[];
  readonly namespaces: RustNamespaceTables;
  /** Names already used in this file, by base name, with the namespaces and condition of each. */
  readonly seen: Map<
    string,
    { readonly namespaces: readonly RustNamespace[]; readonly condition: string | undefined }[]
  >;
}

/** One name to declare. */
interface DeclInput {
  /** The name without a macro's `!` and without any `#n`, as recorded in the namespace tables. */
  readonly bare: string;
  /** The full name before `#n` is added, such as `tests::User.save`. */
  readonly base: string;
  readonly symbolType: SymbolType;
  readonly visibility: Visibility;
  readonly owner: string | null;
  /** Namespaces the name takes, for clashes between items of one scope. */
  readonly namespaces: readonly RustNamespace[];
  /** The span of the item. */
  readonly span: Span;
  readonly condition: string | undefined;
  /** Whether the name is recorded in this scope's namespace tables (module-level items only). */
  readonly register: boolean;
  readonly scope: Scope;
  /** The function being declared, and the impl or trait it sits in, for the call pass (9.6). */
  readonly fn?: { readonly item: FnItem; readonly container: Item | null };
}

/** Declares the items of one Rust file. Never throws; syntax problems are reported by the parser. */
export function analyzeRustSymbols(file: RustFile, filePath: string): RustSymbolAnalysis {
  const walk: Walk = {
    filePath,
    declarations: [],
    functions: [],
    namespaces: new Map(),
    seen: new Map(),
  };
  walkModule(walk, file.items, { modulePath: '', key: filePath, conditions: [] });
  return {
    declarations: walk.declarations,
    namespaces: walk.namespaces,
    functions: walk.functions,
  };
}

function walkModule(walk: Walk, items: readonly Item[], scope: Scope): void {
  for (const item of items) walkModuleItem(walk, item, scope);
}

/** Declares the items written inside a function body, under the function's name (9.8). */
function walkFnBody(walk: Walk, item: FnItem, fnId: string, fnBase: string, scope: Scope): void {
  if (item.body === null) return;
  for (const block of bodyBlocksOf(item.body)) {
    walkModule(walk, block.items, {
      modulePath: `${fnBase}::`,
      key: blockKey(fnId, block.position),
      conditions: scope.conditions,
    });
  }
}

/** Declares the items written inside a const's or static's value, under the value's name (9.8). */
function walkValueBlocks(
  walk: Walk,
  value: { readonly tokens: readonly TokenTree[] } | null,
  valueId: string,
  valueBase: string,
  scope: Scope,
): void {
  if (value === null) return;
  for (const block of blocksOfTokens(value.tokens)) {
    walkModule(walk, block.items, {
      modulePath: `${valueBase}::`,
      key: blockKey(valueId, block.position),
      conditions: scope.conditions,
    });
  }
}

function walkModuleItem(walk: Walk, item: Item, scope: Scope): void {
  const visibility = toVisibility(item.vis);
  const ownCfg = cfgTexts(item.attrs);
  const condition = conditionText([...scope.conditions, ...ownCfg]);
  const base = (name: string): string => `${scope.modulePath}${name}`;
  const declareModuleItem = (
    name: string,
    symbolType: SymbolType,
    namespaces: readonly RustNamespace[],
  ): string => {
    return declare(walk, {
      bare: name,
      base: base(name),
      symbolType,
      visibility,
      owner: null,
      namespaces,
      span: item.span,
      condition,
      register: true,
      scope,
    });
  };

  switch (item.kind) {
    case 'fn': {
      const fnId = declare(walk, {
        bare: item.name,
        base: base(item.name),
        symbolType: 'function',
        visibility,
        owner: null,
        namespaces: ['value'],
        span: item.span,
        condition,
        register: true,
        scope,
        fn: { item, container: null },
      });
      walkFnBody(walk, item, fnId, base(item.name), scope);
      return;
    }
    case 'struct':
      declareModuleItem(item.name, 'struct', namespacesOf(item));
      return;
    case 'union':
      declareModuleItem(item.name, 'struct', ['type']);
      return;
    case 'enum':
      declareModuleItem(item.name, 'enum', ['type']);
      // Variants are symbols named `Enum.Variant`, as associated items are named `Type.item` (9.7).
      for (const variant of item.variants) {
        declare(walk, {
          bare: variant.name,
          base: base(`${item.name}.${variant.name}`),
          symbolType: 'variant',
          visibility,
          owner: null,
          namespaces: [],
          span: item.span,
          condition,
          register: false,
          scope,
        });
      }
      return;
    case 'type':
      declareModuleItem(item.name, 'type', ['type']);
      return;
    case 'const':
      if (item.name !== '_') {
        const constId = declareModuleItem(item.name, 'constant', ['value']);
        walkValueBlocks(walk, item.value, constId, base(item.name), scope);
      }
      return;
    case 'static': {
      const staticId = declareModuleItem(item.name, 'variable', ['value']);
      walkValueBlocks(walk, item.value, staticId, base(item.name), scope);
      return;
    }
    case 'macro_rules':
      declare(walk, {
        bare: item.name,
        base: base(`${item.name}!`),
        symbolType: 'macro',
        visibility,
        owner: null,
        namespaces: ['macro'],
        span: item.span,
        condition,
        register: true,
        scope,
      });
      return;
    case 'trait': {
      declareModuleItem(item.name, 'trait', ['type']);
      const traitBase = base(item.name);
      walkContainer(walk, item.items, {
        container: item,
        base: traitBase,
        owner: `${walk.filePath}:${traitBase}`,
        visibility,
        scope: childScope(scope, ownCfg),
      });
      return;
    }
    case 'impl':
      walkImpl(walk, item, scope, ownCfg);
      return;
    case 'mod': {
      if (!item.inline) return; // `mod x;` is a file; the module tree (Phase 8) covers it.
      declareModuleItem(item.name, 'module', ['type']);
      const modulePath = `${scope.modulePath}${item.name}::`;
      walkModule(walk, item.items, {
        modulePath,
        key: `${walk.filePath}:${modulePath.slice(0, -2)}`,
        conditions: [...scope.conditions, ...ownCfg],
      });
      return;
    }
    case 'extern_block':
      // Items in an `extern` block are declared in the enclosing module, with their own cfg.
      walkModule(walk, item.items, childScope(scope, ownCfg));
      return;
    default:
      // `use`, `extern crate`, macro invocations and unparsed items define no name here.
      return;
  }
}

/** Walks the functions of an impl or trait body, as methods of `base`. */
function walkContainer(
  walk: Walk,
  items: readonly Item[],
  container: {
    /** The impl or trait item whose functions these are. */
    readonly container: Item;
    readonly base: string;
    readonly owner: string;
    /** The visibility of every method, or null to use each method's own. */
    readonly visibility: Visibility | null;
    readonly scope: Scope;
  },
): void {
  for (const item of items) {
    if (item.kind !== 'fn') continue;
    const fnId = declare(walk, {
      bare: item.name,
      base: `${container.base}.${item.name}`,
      symbolType: 'method',
      visibility: container.visibility ?? toVisibility(item.vis),
      owner: container.owner,
      namespaces: ['value'],
      span: item.span,
      condition: conditionText([...container.scope.conditions, ...cfgTexts(item.attrs)]),
      register: false,
      scope: container.scope,
      fn: { item, container: container.container },
    });
    walkFnBody(walk, item, fnId, `${container.base}.${item.name}`, container.scope);
  }
}

/** Names the methods of an impl after its type, and a trait impl after its type and trait. */
function walkImpl(
  walk: Walk,
  item: Extract<Item, { kind: 'impl' }>,
  scope: Scope,
  ownCfg: readonly string[],
): void {
  const typeName = headName(item.selfTy);
  const traitName = item.trait === null ? null : headName(item.trait);
  // An impl on a type this pass cannot name (`&T`, `[T]`, a tuple) has no name to give its methods.
  if (typeName === null || (item.trait !== null && traitName === null)) return;
  const typeBase = `${scope.modulePath}${typeName}`;
  const base = traitName === null ? typeBase : `${typeBase}[${traitName}]`;
  walkContainer(walk, item.items, {
    container: item,
    base,
    owner: `${walk.filePath}:${typeBase}`,
    // A trait impl's methods are public whenever the trait is used, so the impl does not narrow them.
    visibility: item.trait === null ? null : 'public',
    scope: childScope(scope, ownCfg),
  });
}

/** The scope inside an item: its own `cfg` conditions are added to the enclosing ones. */
function childScope(scope: Scope, ownCfg: readonly string[]): Scope {
  return { ...scope, conditions: [...scope.conditions, ...ownCfg] };
}

/**
 * Adds one declaration. A repeated base name gets `#n` when it clashes with an earlier one: the
 * two share a namespace with the same condition, or they are in different namespaces. Two
 * definitions in one namespace under different conditions are twins, and keep one id.
 */
function declare(walk: Walk, input: DeclInput): string {
  const prior = walk.seen.get(input.base) ?? [];
  const clash = prior.some(
    (p) =>
      p.condition === input.condition ||
      !p.namespaces.some((namespace) => input.namespaces.includes(namespace)),
  );
  const name = clash ? `${input.base}#${prior.length + 1}` : input.base;
  walk.seen.set(input.base, [
    ...prior,
    { namespaces: input.namespaces, condition: input.condition },
  ]);

  const id = `${walk.filePath}:${name}`;
  if (input.fn !== undefined) {
    walk.functions.push({ item: input.fn.item, id, container: input.fn.container });
  }
  walk.declarations.push({
    kind: 'declaration',
    filePath: walk.filePath,
    span: toSourceSpan(input.span, walk.filePath),
    id,
    name,
    symbolType: input.symbolType,
    owner: input.owner,
    visibility: input.visibility,
    exported: false,
    ...(input.condition === undefined ? {} : { condition: input.condition }),
  });

  if (input.register) {
    recordName(walk.namespaces, input.scope.key, input.namespaces, input.bare, id);
  }
  return id;
}

/**
 * The name of the type or trait a fragment refers to: the last identifier of its path, with
 * `crate`, `self`, `super`, `dyn` and `mut` skipped. Returns null for anything else (`&T`, `[T]`,
 * tuples), because those do not name one type.
 */
export function headName(fragment: Fragment | null): string | null {
  if (fragment === null) return null;
  let name: string | null = null;
  for (const tree of fragment.tokens) {
    if (isTokenGroup(tree)) break;
    if (tree.kind === 'ident') {
      if (tree.value === 'for' || tree.value === 'where') break;
      if (!SKIPPED_PATH_WORDS.has(tree.value)) name = tree.value;
      continue;
    }
    if (tree.kind === 'punct' && tree.text === '::') continue;
    break;
  }
  return name;
}

const SKIPPED_PATH_WORDS: ReadonlySet<string> = new Set(['crate', 'self', 'super', 'dyn', 'mut']);

function cfgTexts(attrs: readonly Attribute[]): readonly string[] {
  return attrs.filter((attr) => attr.path === 'cfg').map((attr) => `cfg ${attr.raw}`);
}

function conditionText(conditions: readonly string[]): string | undefined {
  return conditions.length === 0 ? undefined : conditions.join(' && ');
}

function toVisibility(vis: RustVisibility): Visibility {
  if (vis.kind === 'public') return 'public';
  if (vis.kind === 'private') return 'private';
  return vis.scope === 'self' ? 'private' : 'module';
}

function toSourceSpan(span: Span, filePath: string): SourceSpan {
  return {
    filePath,
    startLine: span.line,
    startColumn: span.column,
    endLine: span.endLine,
    endColumn: span.endColumn,
  };
}
