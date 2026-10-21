import { describe, expect, it } from 'vitest';
import {
  afterRebinding,
  annotationType,
  constructorType,
  peelType,
  returnType,
  type LocalType,
  type TypeExpr,
} from './local-types.js';

const user: TypeExpr = { kind: 'named', name: { kind: 'symbol', id: 'src/m.py:User' } };
const userType: LocalType = {
  name: { kind: 'symbol', id: 'src/m.py:User' },
  confidence: 'high',
  source: 'annotation',
};

describe('peelType', () => {
  it('peels Optional, X | None, Annotated, references, Box, Rc and Arc', () => {
    for (const wrapper of ['Optional', 'X | None', 'Annotated', '&', '&mut', 'Box', 'Rc', 'Arc']) {
      expect(peelType({ kind: 'wrapped', wrapper, inner: user })).toEqual(user);
    }
  });

  it('does not peel Option, which is a different type from its contents', () => {
    const option: TypeExpr = { kind: 'wrapped', wrapper: 'Option', inner: user };
    expect(peelType(option)).toEqual(option);
  });
});

describe('annotationType', () => {
  it('is high confidence for a named type, through wrappers', () => {
    expect(annotationType({ kind: 'wrapped', wrapper: 'Optional', inner: user })).toEqual(userType);
  });

  it('gives no type for an unknown or unpeeled annotation', () => {
    expect(annotationType({ kind: 'unknown' })).toBeUndefined();
    expect(annotationType({ kind: 'wrapped', wrapper: 'Option', inner: user })).toBeUndefined();
  });
});

describe('constructorType', () => {
  it('is high confidence for a resolved class or struct', () => {
    expect(constructorType({ id: 'src/m.py:User', symbolType: 'class' })).toEqual({
      name: { kind: 'symbol', id: 'src/m.py:User' },
      confidence: 'high',
      source: 'constructor',
    });
    expect(constructorType({ id: 'src/m.rs:Cfg', symbolType: 'struct' })?.confidence).toBe('high');
  });

  it('gives no type for a plain function call', () => {
    expect(constructorType({ id: 'src/m.py:make', symbolType: 'function' })).toBeUndefined();
  });
});

describe('returnType', () => {
  it('is medium confidence for an internal declared return type', () => {
    const callee = {
      id: 'src/m.py:load',
      symbolType: 'function' as const,
      returnType: {
        kind: 'named' as const,
        name: { kind: 'symbol' as const, id: 'src/m.py:User' },
      },
    };
    expect(returnType(callee)).toEqual({
      name: { kind: 'symbol', id: 'src/m.py:User' },
      confidence: 'medium',
      source: 'return-type',
    });
  });

  it('resolves Self to the owning type, at medium confidence', () => {
    const method = {
      id: 'src/m.rs:Builder.with',
      symbolType: 'method' as const,
      returnType: { kind: 'self' as const },
      ownerTypeId: 'src/m.rs:Builder',
    };
    expect(returnType(method)).toEqual({
      name: { kind: 'symbol', id: 'src/m.rs:Builder' },
      confidence: 'medium',
      source: 'return-type',
    });
    expect(returnType({ ...method, ownerTypeId: undefined })).toBeUndefined();
  });

  it('gives no type for an external return type or a class', () => {
    expect(
      returnType({
        id: 'src/m.py:now',
        symbolType: 'function',
        returnType: { kind: 'named', name: { kind: 'external', name: 'datetime.datetime' } },
      }),
    ).toBeUndefined();
    expect(returnType({ id: 'src/m.py:User', symbolType: 'class' })).toBeUndefined();
  });
});

describe('afterRebinding', () => {
  const other: LocalType = { ...userType, name: { kind: 'symbol', id: 'src/m.py:Admin' } };

  it('keeps the type when a name is rebound to the same type', () => {
    expect(afterRebinding(userType, { ...userType, source: 'constructor' })).toBe(userType);
  });

  it('removes the type when a name is rebound to a different type', () => {
    expect(afterRebinding(userType, other)).toBeUndefined();
  });

  it('removes the type when the new value has an unknown type', () => {
    expect(afterRebinding(userType, undefined)).toBeUndefined();
  });

  it('keeps an unknown type unknown', () => {
    expect(afterRebinding(undefined, userType)).toBeUndefined();
  });
});
