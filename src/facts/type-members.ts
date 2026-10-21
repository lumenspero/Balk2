import type { TypeName } from './local-types.js';

/**
 * The type-members query (Phase 2.5). Receiver rules such as `event-like` ask one question: which
 * methods does a type have? Each front end supplies its declarations, and this module answers the
 * same way for every language.
 *
 * - JS/TS: declarations come from the checker's types.
 * - Python: repository classes with their bases, plus the known library types below.
 * - Rust: each type's methods from its inherent and trait impls. Rust's supertraits are bases.
 */

/** One type as a front end describes it. */
export interface TypeDeclaration {
  readonly name: TypeName;
  /** Base types in declared order: Python bases, or Rust supertraits. */
  readonly bases: readonly TypeName[];
  /** Methods defined directly on this type, from its class body or impl blocks. */
  readonly methods: readonly string[];
}

/** The methods a type has, and how sure the query is of the list. */
export interface TypeMembers {
  /** Every method on the type and its ancestors. */
  readonly methods: ReadonlySet<string>;
  /** The method resolution order, as type keys, starting with the type itself. */
  readonly order: readonly string[];
  /**
   * False when some ancestor is not declared, so a method could be missing from the list. A
   * present method is still evidence. An absent method is not proof that the type lacks it.
   */
  readonly complete: boolean;
}

/** Answers what methods a type has. */
export interface TypeMembersQuery {
  membersOf(type: TypeName): TypeMembers | undefined;
}

/** A stable key for a type name, used for lookups and for the method resolution order. */
export function typeKey(name: TypeName): string {
  return name.kind === 'symbol' ? `symbol:${name.id}` : `external:${name.name}`;
}

/**
 * Builds the query from declarations. A type's order is C3 linearization over its bases, as
 * Python computes the method resolution order. Unknown bases are leaves with no methods, and make
 * the result incomplete. A cycle, or a base order C3 cannot merge, gives no members.
 */
export function createTypeMembersQuery(declarations: readonly TypeDeclaration[]): TypeMembersQuery {
  const byKey = new Map(declarations.map((decl) => [typeKey(decl.name), decl]));
  const memo = new Map<string, string[] | null>();

  const linearize = (key: string, stack: ReadonlySet<string>): string[] | undefined => {
    const decl = byKey.get(key);
    if (decl === undefined) return [key];
    if (stack.has(key)) return undefined;

    const cached = memo.get(key);
    if (cached !== undefined) return cached ?? undefined;

    const inner = new Set(stack).add(key);
    const baseKeys = decl.bases.map(typeKey);
    const baseOrders = baseKeys.map((base) => linearize(base, inner));
    if (baseOrders.some((order) => order === undefined)) {
      memo.set(key, null);
      return undefined;
    }

    const merged = c3Merge([...(baseOrders as string[][]), baseKeys]);
    const result = merged === undefined ? null : [key, ...merged];
    memo.set(key, result);
    return result ?? undefined;
  };

  return {
    membersOf(type: TypeName): TypeMembers | undefined {
      const key = typeKey(type);
      if (!byKey.has(key)) return undefined;

      const order = linearize(key, new Set());
      if (order === undefined) return undefined;

      const methods = new Set<string>();
      for (const entry of order) {
        for (const method of byKey.get(entry)?.methods ?? []) methods.add(method);
      }
      const complete = order.every((entry) => byKey.has(entry));
      return { methods, order, complete };
    },
  };
}

/** C3 merge of base linearizations, or undefined when the bases have no consistent order. */
function c3Merge(sequences: readonly (readonly string[])[]): string[] | undefined {
  const pending = sequences.map((sequence) => [...sequence]);
  const out: string[] = [];
  for (;;) {
    const nonEmpty = pending.filter((sequence) => sequence.length > 0);
    if (nonEmpty.length === 0) return out;

    const heads = nonEmpty
      .map((sequence) => sequence[0])
      .filter((head): head is string => head !== undefined);
    const candidate = heads.find((head) =>
      nonEmpty.every((sequence) => !sequence.slice(1).includes(head)),
    );
    if (candidate === undefined) return undefined;

    out.push(candidate);
    for (const sequence of pending) {
      if (sequence[0] === candidate) sequence.shift();
    }
  }
}

/** Library types the Python front end knows, with the methods the event rules use. */
export const PYTHON_LIBRARY_TYPES: readonly TypeDeclaration[] = [
  {
    name: { kind: 'external', name: 'pyee.EventEmitter' },
    bases: [],
    methods: ['on', 'once', 'emit', 'remove_listener'],
  },
  {
    name: { kind: 'external', name: 'asyncio.Event' },
    bases: [],
    methods: ['set', 'wait', 'clear', 'is_set'],
  },
  {
    name: { kind: 'external', name: 'threading.Event' },
    bases: [],
    methods: ['set', 'wait', 'clear', 'is_set'],
  },
];

/** The key for a type whose members a front end resolved directly, such as the checker's types. */
export const RESOLVED_TYPE: TypeName = { kind: 'external', name: 'resolved-type' };

/**
 * A query over one resolved type. The front end has already listed every member, inherited ones
 * included (the TypeScript checker does this), so the query has no bases and is complete.
 */
export function resolvedTypeQuery(methods: readonly string[]): TypeMembersQuery {
  const members: TypeMembers = { methods: new Set(methods), order: [], complete: true };
  return { membersOf: () => members };
}

/** True when the type has at least one of the methods. */
export function hasAnyMethod(
  query: TypeMembersQuery,
  type: TypeName,
  methods: readonly string[],
): boolean {
  const members = query.membersOf(type);
  return members !== undefined && methods.some((method) => members.methods.has(method));
}

/** True when the type has every one of the methods. */
export function hasMethods(
  query: TypeMembersQuery,
  type: TypeName,
  methods: readonly string[],
): boolean {
  const members = query.membersOf(type);
  return members !== undefined && methods.every((method) => members.methods.has(method));
}

/**
 * The `event-like` receiver rule: the type declares at least one subscribe method and at least one
 * emit or dispatch method from the active catalog. A type without both is not an event receiver.
 */
export function isEventLike(
  query: TypeMembersQuery,
  type: TypeName,
  catalog: { readonly subscribe: readonly string[]; readonly emit: readonly string[] },
): boolean {
  const members = query.membersOf(type);
  if (members === undefined) return false;
  const has = (names: readonly string[]): boolean =>
    names.some((name) => members.methods.has(name));
  return has(catalog.subscribe) && has(catalog.emit);
}
