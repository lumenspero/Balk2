import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  callArguments,
  createRepositoryFixture,
  type RepositoryFixture,
} from '../testing/repository-fixture.js';
import { resolveEventName, resolveEventObject, type EventNameResolution } from './event-names.js';

// Each group builds one TypeScript program; the default 5s limit is tight on a busy machine.
vi.setConfig({ testTimeout: 30_000 });

interface Case {
  readonly label: string;
  /** One statement containing exactly one `probe(...)` call. */
  readonly code: string;
  readonly expected: Partial<EventNameResolution> & { readonly kind: EventNameResolution['kind'] };
}

/** Resolve every case's probe argument in a single program. */
function resolveAll(
  cases: readonly Case[],
  files: Record<string, string>,
  mainFile: string,
  resolve: typeof resolveEventName,
  preamble: string,
): { results: EventNameResolution[]; cleanup: () => void } {
  const source = [preamble, ...cases.map((c) => c.code)].join('\n');
  const fixture: RepositoryFixture = createRepositoryFixture({ ...files, [mainFile]: source });
  const args = callArguments(fixture.repository, mainFile);
  if (args.length !== cases.length) {
    throw new Error(`Expected ${cases.length} probes, found ${args.length}`);
  }
  return {
    results: args.map((arg) => resolve(arg, fixture.repository.checker)),
    cleanup: fixture.cleanup,
  };
}

const TS_PREAMBLE = `
import { IMPORTED, EVENTS as IMPORTED_EVENTS } from './constants.js';
declare function probe(value: unknown): void;
declare function compute(): string;
declare const wide: string;
declare const anything: any;
declare const ambientLiteral: 'ambient';
const READY = 'ready';
const KIND = 'login';
const NESTED = { USER: { LOGIN: 'user:login' } } as const;
const PLAIN = { START: 'start' };
enum Events { Ready = 'enum-ready', Count = 3 }
class Bus { static readonly TICK = 'tick'; static mutable = 'changing'; }
let mutableName = 'ready';
let narrowed: 'only' = 'only';
`;

const TS_CASES: readonly Case[] = [
  {
    label: 'a string literal',
    code: "probe('ready');",
    expected: { kind: 'static', name: 'ready', via: 'literal', evidence: 'ast' },
  },
  {
    label: 'a template without substitutions',
    code: 'probe(`ready`);',
    expected: { kind: 'static', name: 'ready', via: 'literal' },
  },
  {
    label: 'a template with a constant',
    code: 'probe(`user:${KIND}`);',
    expected: { kind: 'static', name: 'user:login', via: 'template', evidence: 'ts-program' },
  },
  {
    label: 'literal concatenation',
    code: "probe('a' + ':' + 'b');",
    expected: { kind: 'static', name: 'a:b', via: 'concatenation', evidence: 'ast' },
  },
  {
    label: 'a string joined with a number',
    code: "probe('tick' + 1);",
    expected: { kind: 'static', name: 'tick1', via: 'concatenation' },
  },
  {
    label: 'a constant in a concatenation',
    code: "probe(KIND + ':' + 'x');",
    expected: { kind: 'static', name: 'login:x', via: 'concatenation', evidence: 'ts-program' },
  },
  {
    label: 'a const binding',
    code: 'probe(READY);',
    expected: { kind: 'static', name: 'ready', via: 'const-binding', evidence: 'ts-program' },
  },
  {
    label: 'an imported const',
    code: 'probe(IMPORTED);',
    expected: { kind: 'static', name: 'imported', via: 'const-binding' },
  },
  {
    label: 'a property of an imported as-const object',
    code: 'probe(IMPORTED_EVENTS.READY);',
    expected: { kind: 'static', name: 'evt-ready', via: 'object-constant' },
  },
  {
    label: 'a nested as-const object',
    code: 'probe(NESTED.USER.LOGIN);',
    expected: { kind: 'static', name: 'user:login', via: 'object-constant' },
  },
  {
    label: 'a property of a plain const object',
    code: 'probe(PLAIN.START);',
    expected: { kind: 'static', name: 'start', via: 'object-constant' },
  },
  {
    label: 'a bracket access on a const object',
    code: "probe(PLAIN['START']);",
    expected: { kind: 'static', name: 'start', via: 'object-constant' },
  },
  {
    label: 'a string enum member',
    code: 'probe(Events.Ready);',
    expected: { kind: 'static', name: 'enum-ready', via: 'enum-member', evidence: 'ts-program' },
  },
  {
    label: 'a static readonly class property',
    code: 'probe(Bus.TICK);',
    expected: { kind: 'static', name: 'tick', via: 'object-constant' },
  },
  {
    label: 'a variable with a literal declared type',
    code: 'probe(narrowed);',
    expected: { kind: 'static', name: 'only', via: 'literal-type' },
  },
  {
    label: 'an ambient const with a literal type',
    code: 'probe(ambientLiteral);',
    expected: { kind: 'static', name: 'ambient', via: 'literal-type' },
  },
  {
    label: 'a parameter typed as one literal',
    code: "function p1(name: 'fixed') { probe(name); }",
    expected: { kind: 'static', name: 'fixed', via: 'literal-type' },
  },
  {
    label: 'a parenthesized assertion',
    code: "probe(('ready' as const));",
    expected: { kind: 'static', name: 'ready' },
  },
  {
    label: 'a non-null assertion on a constant',
    code: 'probe(READY!);',
    expected: { kind: 'static', name: 'ready' },
  },
  {
    label: 'a long chain of constants',
    code: "const k0 = 'deep'; const k1 = k0; const k2 = k1; const k3 = k2; const k4 = k3; const k5 = k4; const k6 = k5; const k7 = k6; const k8 = k7; const k9 = k8; const k10 = k9; probe(k10);",
    expected: { kind: 'static', name: 'deep' },
  },

  { label: 'a mutable let binding', code: 'probe(mutableName);', expected: { kind: 'dynamic' } },
  {
    label: 'a mutable binding narrowed to one literal by its initializer',
    code: "let kind: 'a' | 'b' = 'a'; probe(kind);",
    expected: { kind: 'dynamic' },
  },
  { label: 'a mutable class property', code: 'probe(Bus.mutable);', expected: { kind: 'dynamic' } },
  { label: 'a string-typed value', code: 'probe(wide);', expected: { kind: 'dynamic' } },
  { label: 'a call result', code: 'probe(compute());', expected: { kind: 'dynamic' } },
  { label: 'an any-typed value', code: 'probe(anything);', expected: { kind: 'dynamic' } },
  {
    label: 'a template with a dynamic part',
    code: 'probe(`x:${wide}`);',
    expected: { kind: 'dynamic' },
  },
  {
    label: 'a concatenation with a dynamic part',
    code: "probe('x' + wide);",
    expected: { kind: 'dynamic' },
  },
  {
    label: 'a parameter typed as a union of literals',
    code: "function p2(name: 'a' | 'b') { probe(name); }",
    expected: { kind: 'dynamic' },
  },
  {
    label: 'a string parameter',
    code: 'function p3(name: string) { probe(name); }',
    expected: { kind: 'dynamic' },
  },
  {
    label: 'a generic string parameter',
    code: 'function p4<T extends string>(name: T) { probe(name); }',
    expected: { kind: 'dynamic' },
  },
  {
    label: 'circular constants',
    code: 'const ca: string = cb; const cb: string = ca; probe(ca);',
    expected: { kind: 'dynamic', reason: 'circular constant' },
  },

  {
    label: 'an object literal (an action, not a name)',
    code: "probe({ type: 'x' });",
    expected: { kind: 'not-a-name' },
  },
  { label: 'a number', code: 'probe(42);', expected: { kind: 'not-a-name' } },
  { label: 'a function', code: 'probe(() => 1);', expected: { kind: 'not-a-name' } },
  { label: 'an array', code: 'probe([1]);', expected: { kind: 'not-a-name' } },
  { label: 'a boolean', code: 'probe(true);', expected: { kind: 'not-a-name' } },
  {
    label: 'a numeric enum member',
    code: 'probe(Events.Count);',
    expected: { kind: 'not-a-name' },
  },
  { label: 'numeric addition', code: 'probe(1 + 2);', expected: { kind: 'not-a-name' } },
];

describe('resolveEventName in TypeScript', () => {
  let results: EventNameResolution[] = [];
  let cleanup = (): void => undefined;

  beforeAll(() => {
    const resolved = resolveAll(
      TS_CASES,
      {
        'constants.ts':
          "export const IMPORTED = 'imported';\nexport const EVENTS = { READY: 'evt-ready' } as const;",
      },
      'names.ts',
      resolveEventName,
      TS_PREAMBLE,
    );
    results = resolved.results;
    cleanup = resolved.cleanup;
  });
  afterAll(() => cleanup());

  it.each(TS_CASES.map((c, index) => [c.label, index] as const))('reads %s', (_label, index) => {
    expect(results[index]).toMatchObject(TS_CASES[index]?.expected ?? {});
  });
});

const JS_CASES: readonly Case[] = [
  {
    label: 'a property of a plain const object',
    code: 'probe(EVENTS.READY);',
    expected: { kind: 'static', name: 'ready', via: 'object-constant' },
  },
  {
    label: 'a const binding',
    code: 'probe(NAME);',
    expected: { kind: 'static', name: 'x', via: 'const-binding' },
  },
  {
    label: 'a nested constant object',
    code: 'probe(ROOT.CHILD.LEAF);',
    expected: { kind: 'static', name: 'leaf', via: 'object-constant' },
  },
  {
    label: 'an untyped parameter',
    code: 'function f(name) { probe(name); }',
    expected: { kind: 'dynamic' },
  },
  { label: 'a let binding', code: 'let n = "a"; probe(n);', expected: { kind: 'dynamic' } },
  { label: 'an object literal', code: 'probe({ type: "a" });', expected: { kind: 'not-a-name' } },
];

describe('resolveEventName in JavaScript', () => {
  let results: EventNameResolution[] = [];
  let cleanup = (): void => undefined;

  beforeAll(() => {
    const preamble =
      "const EVENTS = { READY: 'ready' };\nconst NAME = 'x';\nconst ROOT = { CHILD: { LEAF: 'leaf' } };\nfunction probe() {}";
    const resolved = resolveAll(JS_CASES, {}, 'names.js', resolveEventName, preamble);
    results = resolved.results;
    cleanup = resolved.cleanup;
  });
  afterAll(() => cleanup());

  it.each(JS_CASES.map((c, index) => [c.label, index] as const))('reads %s', (_label, index) => {
    expect(results[index]).toMatchObject(JS_CASES[index]?.expected ?? {});
  });
});

const OBJECT_PREAMBLE = `
declare function probe(value: unknown): void;
declare function makeEvent(): Event;
declare const dynamicName: string;
declare const incoming: Event;
class Ready extends Event { constructor() { super('ready'); } }
`;

const OBJECT_CASES: readonly Case[] = [
  {
    label: 'a new Event',
    code: "probe(new Event('x'));",
    expected: { kind: 'static', name: 'x', via: 'event-object' },
  },
  {
    label: 'a new CustomEvent',
    code: "probe(new CustomEvent('y', { detail: 1 }));",
    expected: { kind: 'static', name: 'y', via: 'event-object' },
  },
  {
    label: 'an Event subclass from the DOM types',
    code: "probe(new MouseEvent('click'));",
    expected: { kind: 'static', name: 'click', via: 'event-object' },
  },
  {
    label: 'a const binding of an event',
    code: "const evt = new Event('const-evt'); probe(evt);",
    expected: { kind: 'static', name: 'const-evt', via: 'event-object' },
  },
  {
    label: 'an event named through a constant',
    code: "const kk = 'kk'; probe(new CustomEvent(kk));",
    expected: { kind: 'static', name: 'kk', via: 'event-object' },
  },
  {
    label: 'an event named by concatenation',
    code: "probe(new Event('a' + 'b'));",
    expected: { kind: 'static', name: 'ab', via: 'event-object' },
  },

  {
    label: 'a mutable event binding',
    code: "let mut = new Event('m'); probe(mut);",
    expected: { kind: 'dynamic', reason: 'event object is a mutable binding' },
  },
  {
    label: 'an event that is not constructed here',
    code: 'probe(incoming);',
    expected: { kind: 'dynamic', reason: 'event object is not statically known' },
  },
  {
    label: 'a dynamic event name',
    code: 'probe(new Event(dynamicName));',
    expected: { kind: 'dynamic' },
  },
  {
    label: 'an event with no name argument',
    code: 'probe(new Event());',
    expected: { kind: 'dynamic', reason: 'event has no name argument' },
  },
  {
    label: 'a subclass that names itself in its constructor',
    code: 'probe(new Ready());',
    expected: { kind: 'dynamic', reason: 'event has no name argument' },
  },
  {
    label: 'a constructor that is not an event',
    code: 'probe(new Date());',
    expected: { kind: 'dynamic', reason: 'not a recognized event constructor' },
  },
  {
    label: 'a call returning an event',
    code: 'probe(makeEvent());',
    expected: { kind: 'dynamic', reason: 'event object is a computed expression' },
  },
];

describe('resolveEventObject', () => {
  let results: EventNameResolution[] = [];
  let cleanup = (): void => undefined;

  beforeAll(() => {
    const resolved = resolveAll(
      OBJECT_CASES,
      {},
      'objects.ts',
      resolveEventObject,
      OBJECT_PREAMBLE,
    );
    results = resolved.results;
    cleanup = resolved.cleanup;
  });
  afterAll(() => cleanup());

  it.each(OBJECT_CASES.map((c, index) => [c.label, index] as const))(
    'reads %s',
    (_label, index) => {
      expect(results[index]).toMatchObject(OBJECT_CASES[index]?.expected ?? {});
    },
  );

  it('explains a dynamic event name in the reason', () => {
    const dynamic = results[8];
    expect(dynamic).toMatchObject({ kind: 'dynamic' });
    expect(dynamic?.kind === 'dynamic' ? dynamic.reason : '').toMatch(/^event name: /);
  });
});
