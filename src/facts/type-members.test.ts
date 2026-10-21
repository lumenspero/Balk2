import { describe, expect, it } from 'vitest';
import type { TypeName } from './local-types.js';
import {
  createTypeMembersQuery,
  hasAnyMethod,
  hasMethods,
  isEventLike,
  PYTHON_LIBRARY_TYPES,
  RESOLVED_TYPE,
  resolvedTypeQuery,
  type TypeDeclaration,
} from './type-members.js';

const sym = (id: string): TypeName => ({ kind: 'symbol', id });
const ext = (name: string): TypeName => ({ kind: 'external', name });

describe('createTypeMembersQuery', () => {
  it('follows C3 order for a diamond', () => {
    const decls: TypeDeclaration[] = [
      { name: sym('D'), bases: [sym('B'), sym('C')], methods: [] },
      { name: sym('B'), bases: [sym('A')], methods: ['b'] },
      { name: sym('C'), bases: [sym('A')], methods: ['c'] },
      { name: sym('A'), bases: [], methods: ['a'] },
    ];
    const members = createTypeMembersQuery(decls).membersOf(sym('D'));
    expect(members?.order).toEqual(['symbol:D', 'symbol:B', 'symbol:C', 'symbol:A']);
    expect([...(members?.methods ?? [])].sort()).toEqual(['a', 'b', 'c']);
    expect(members?.complete).toBe(true);
  });

  it('marks the result incomplete when a base is not declared', () => {
    const decls: TypeDeclaration[] = [
      { name: sym('Dog'), bases: [ext('torch.nn.Module')], methods: ['bark'] },
    ];
    const members = createTypeMembersQuery(decls).membersOf(sym('Dog'));
    expect(members?.complete).toBe(false);
    expect(members?.methods.has('bark')).toBe(true);
  });

  it('gives no members for an unknown type, a cycle, or an order C3 cannot merge', () => {
    const cycle: TypeDeclaration[] = [
      { name: sym('A'), bases: [sym('B')], methods: [] },
      { name: sym('B'), bases: [sym('A')], methods: [] },
    ];
    expect(createTypeMembersQuery(cycle).membersOf(sym('A'))).toBeUndefined();
    expect(createTypeMembersQuery([]).membersOf(sym('Nope'))).toBeUndefined();

    const inconsistent: TypeDeclaration[] = [
      { name: sym('X'), bases: [sym('A'), sym('B')], methods: [] },
      { name: sym('A'), bases: [sym('B')], methods: [] },
      { name: sym('B'), bases: [sym('A')], methods: [] },
    ];
    expect(createTypeMembersQuery(inconsistent).membersOf(sym('X'))).toBeUndefined();
  });
});

describe('receiver rules', () => {
  const query = createTypeMembersQuery([
    ...PYTHON_LIBRARY_TYPES,
    { name: sym('Cache'), bases: [], methods: ['get', 'put'] },
    { name: sym('Bus'), bases: [], methods: ['subscribe', 'publish'] },
  ]);
  const catalog = { subscribe: ['on', 'subscribe'], emit: ['emit', 'publish'] };

  it('treats pyee EventEmitter and a repository bus as event-like', () => {
    expect(isEventLike(query, ext('pyee.EventEmitter'), catalog)).toBe(true);
    expect(isEventLike(query, sym('Bus'), catalog)).toBe(true);
  });

  it('does not treat a type with no subscribe or no emit method as event-like', () => {
    expect(isEventLike(query, sym('Cache'), catalog)).toBe(false);
    expect(isEventLike(query, ext('unknown.Thing'), catalog)).toBe(false);
  });

  it('checks that every required method is present', () => {
    expect(hasMethods(query, sym('Cache'), ['get', 'put'])).toBe(true);
    expect(hasMethods(query, sym('Cache'), ['get', 'delete'])).toBe(false);
  });
});

describe('resolvedTypeQuery', () => {
  it('answers from the methods a front end resolved, as complete', () => {
    const query = resolvedTypeQuery(['on', 'emit']);
    const members = query.membersOf(RESOLVED_TYPE);
    expect(members?.complete).toBe(true);
    expect(hasAnyMethod(query, RESOLVED_TYPE, ['off', 'emit'])).toBe(true);
    expect(hasAnyMethod(query, RESOLVED_TYPE, ['off', 'close'])).toBe(false);
  });
});
