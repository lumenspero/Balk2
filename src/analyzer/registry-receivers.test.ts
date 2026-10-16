import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Expression } from 'typescript';
import {
  callArguments,
  createRepositoryFixture,
  type RepositoryFixture,
} from '../testing/repository-fixture.js';
import { RegistryProtocolCatalog, type RegistryRule } from './registry-protocols.js';
import {
  qualifyRegistryReceiver,
  type RegistryContainer,
  type RegistryQualification,
} from './registry-receivers.js';

const FILES: Record<string, string> = {
  'types.ts': [
    'export class Container { register(key: string, value: unknown): void {} resolve(key: string): unknown { return 0; } }',
    'export class Cache { get(key: string): unknown { return 0; } }',
    'export class Writer { register(key: string, value: unknown): void {} }',
    'export class Store { add(key: string): void {} has(key: string): boolean { return true; } }',
    'export class Router { navigate(path: string): void {} }',
    'export interface Dict { [key: string]: number }',
    'export interface Numbered { [key: number]: string }',
  ].join('\n'),
  'consumer.ts': [
    "import { Container, Cache, Writer, Store, Router, type Dict, type Numbered } from './types.js';",
    'declare function probe(value: unknown): void;',
    'declare const map: Map<string, number>;',
    'declare const dict: Dict;',
    'declare const numbered: Numbered;',
    'declare const list: number[];',
    'declare const set: Set<string>;',
    'declare const container: Container;',
    'declare const cache: Cache;',
    'declare const writer: Writer;',
    'declare const store: Store;',
    'declare const router: Router;',
    'declare const plain: { a: number };',
    'declare const anything: any;',
    'probe(map); probe(dict); probe(numbered); probe(list); probe(set); probe(container);',
    'probe(cache); probe(writer); probe(store); probe(router); probe(plain); probe(anything);',
    'export {};',
  ].join('\n'),
};

/** The probe arguments in source order, one per declared value above. */
const CASES: ReadonlyArray<{
  readonly label: string;
  readonly qualifies: boolean;
  readonly container: RegistryContainer;
  readonly reason?: string;
}> = [
  { label: 'a Map', qualifies: true, container: 'typed' },
  { label: 'a string-keyed dictionary', qualifies: true, container: 'object' },
  { label: 'a number-indexed dictionary', qualifies: true, container: 'object' },
  { label: 'an array', qualifies: false, container: 'typed' },
  { label: 'a Set', qualifies: true, container: 'typed' },
  { label: 'a class with register and lookup methods', qualifies: true, container: 'typed' },
  { label: 'a class with only a lookup method', qualifies: false, container: 'typed' },
  { label: 'a class with only a register method', qualifies: false, container: 'typed' },
  { label: 'a set-like class (add and has)', qualifies: true, container: 'typed' },
  { label: 'a class with only a navigation method', qualifies: false, container: 'typed' },
  { label: 'a plain object type', qualifies: false, container: 'typed' },
  {
    label: 'an any-typed value',
    qualifies: false,
    container: 'typed',
    reason: 'receiver type is not known',
  },
];

describe('qualifyRegistryReceiver', () => {
  let fixture: RepositoryFixture | undefined;
  let args: Expression[] = [];
  const catalog = new RegistryProtocolCatalog();

  beforeAll(() => {
    fixture = createRepositoryFixture(FILES, { target: 'ES2022', strict: true });
    args = callArguments(fixture.repository, 'consumer.ts');
  });
  afterAll(() => fixture?.cleanup());

  const qualify = (index: number, rule: RegistryRule = 'registry-like'): RegistryQualification => {
    const arg = args[index];
    if (!fixture || !arg) throw new Error(`no probe argument ${index}`);
    return qualifyRegistryReceiver(rule, arg, catalog, fixture.repository.checker);
  };

  it('finds one probe argument per declared value', () => {
    expect(args).toHaveLength(CASES.length);
  });

  it.each(CASES.map((testCase, index) => [index, testCase] as const))(
    'classifies %# as %s',
    (index, testCase) => {
      expect(qualify(index)).toMatchObject({
        qualifies: testCase.qualifies,
        container: testCase.container,
        evidence: 'ts-program',
        ...(testCase.reason ? { reason: testCase.reason } : {}),
      });
    },
  );

  it('a configured name qualifies a receiver whatever its type, with config evidence', () => {
    expect(qualify(6, { names: ['cache'] })).toMatchObject({
      qualifies: true,
      evidence: 'config',
      container: 'typed',
    });
    expect(qualify(10, { names: ['cache'] })).toMatchObject({
      qualifies: false,
      reason: 'receiver matches neither names nor types',
    });
  });

  it('a configured type name qualifies a receiver of that type', () => {
    expect(qualify(5, { types: ['Container'] })).toMatchObject({
      qualifies: true,
      evidence: 'config',
    });
  });

  it('any qualifies every receiver without a type check', () => {
    expect(qualify(3, 'any')).toEqual({
      qualifies: true,
      evidence: 'ast',
      container: 'typed',
      internal: false,
    });
  });
});
