import { describe, expect, it } from 'vitest';
import { ownerIdOf } from './owner-rule.js';

const file = 'src/m.ts';

describe('ownerIdOf', () => {
  it('names a top-level function, class and function-valued variable by their name', () => {
    expect(ownerIdOf(file, [{ kind: 'function', name: 'parse' }])).toBe('src/m.ts:parse');
    expect(ownerIdOf(file, [{ kind: 'class', name: 'User' }])).toBe('src/m.ts:User');
    expect(ownerIdOf(file, [{ kind: 'function-variable', name: 'load' }])).toBe('src/m.ts:load');
  });

  it('qualifies a method with its class', () => {
    expect(
      ownerIdOf(file, [
        { kind: 'class', name: 'User' },
        { kind: 'method', name: 'save' },
      ]),
    ).toBe('src/m.ts:User.save');
  });

  it('qualifies a method of a nested class with every enclosing class (D6)', () => {
    expect(
      ownerIdOf(file, [
        { kind: 'class', name: 'Outer' },
        { kind: 'class', name: 'Inner' },
        { kind: 'method', name: 'run' },
      ]),
    ).toBe('src/m.ts:Outer.Inner.run');
    expect(
      ownerIdOf(file, [
        { kind: 'class', name: 'Outer' },
        { kind: 'class', name: 'Inner' },
      ]),
    ).toBe('src/m.ts:Outer.Inner');
  });

  it('qualifies a method of a named object literal with the object name', () => {
    expect(
      ownerIdOf(file, [
        { kind: 'object', name: 'api' },
        { kind: 'method', name: 'load' },
      ]),
    ).toBe('src/m.ts:api.load');
  });

  it('makes a function nested in another function its own owner, without qualifier', () => {
    expect(
      ownerIdOf(file, [
        { kind: 'function', name: 'outer' },
        { kind: 'function', name: 'inner' },
      ]),
    ).toBe('src/m.ts:inner');
  });

  it('gives module-level code the file as its owner', () => {
    expect(ownerIdOf(file, [])).toBe('src/m.ts');
  });
});
