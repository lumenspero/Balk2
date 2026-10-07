import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  callArguments,
  createRepositoryFixture,
  type RepositoryFixture,
} from '../testing/repository-fixture.js';
import { EventProtocolCatalog, type ReceiverRule } from './event-protocols.js';
import {
  qualifyReceiver,
  ReceiverResolver,
  type ReceiverIdentity,
  type ReceiverQualification,
} from './event-receivers.js';

vi.setConfig({ testTimeout: 30_000 });

type Expected =
  | { readonly kind: 'resolved'; readonly scope: string; readonly confidence: 'high' | 'medium' }
  | { readonly kind: 'unknown' };

interface Group {
  /** Statements containing one `probe(receiver)` call per entry of `probes`, in order. */
  readonly code: string;
  readonly probes: ReadonlyArray<{ readonly label: string; readonly expected: Expected }>;
}

const resolved = (scope: string, confidence: 'high' | 'medium' = 'high'): Expected => ({
  kind: 'resolved',
  scope,
  confidence,
});
const unknown: Expected = { kind: 'unknown' };

const FILES: Record<string, string> = {
  'bus.ts': [
    'export class Emitter {',
    '  on(event: string, listener: () => void): void {}',
    '  emit(event: string): void {}',
    '}',
    'export const bus = new Emitter();',
    'export const other = new Emitter();',
  ].join('\n'),
  'barrel.ts': "export { bus } from './bus.js';",
  'shared.ts': "import { Emitter } from './bus.js';\nexport default new Emitter();",
  'a.ts':
    'declare function probe(value: unknown): void;\nconst bus = { name: "a" };\nprobe(bus);\nexport {};',
  'b.ts':
    'declare function probe(value: unknown): void;\nconst bus = { name: "b" };\nprobe(bus);\nexport {};',
  'other-consumer.ts':
    "import { bus } from './bus.js';\ndeclare function probe(value: unknown): void;\nprobe(bus);",
};

const PREAMBLE = `
import { bus, other, Emitter } from './bus.js';
import { bus as renamed } from './barrel.js';
import shared from './shared.js';
import { ghost } from 'not-installed';
declare function probe(value: unknown): void;
declare function getBus(): Emitter;
const alias = bus;
const local = new Emitter();
`;

const GROUPS: readonly Group[] = [
  {
    code: 'probe(bus);',
    probes: [{ label: 'an imported module-level emitter', expected: resolved('bus.ts:bus') }],
  },
  {
    code: 'probe(other);',
    probes: [
      { label: 'a second emitter from the same module', expected: resolved('bus.ts:other') },
    ],
  },
  {
    code: 'probe(renamed);',
    probes: [
      {
        label: 'an emitter re-exported through a barrel and renamed',
        expected: resolved('bus.ts:bus'),
      },
    ],
  },
  {
    code: 'probe(alias);',
    probes: [{ label: 'a const alias of an emitter', expected: resolved('bus.ts:bus') }],
  },
  {
    code: 'probe(local);',
    probes: [
      { label: 'a module-level emitter in this file', expected: resolved('consumer.ts:local') },
    ],
  },
  {
    code: 'probe(shared);',
    probes: [{ label: 'a default-exported emitter', expected: resolved('shared.ts:default') }],
  },
  {
    code: 'function setup(param: Emitter): void { const inner = new Emitter(); probe(param); probe(inner); }',
    probes: [
      { label: 'a parameter', expected: resolved('consumer.ts:setup.param', 'medium') },
      { label: 'a local variable', expected: resolved('consumer.ts:setup.inner', 'medium') },
    ],
  },
  {
    code: 'probe(document); probe(window.document);',
    probes: [
      { label: 'a global declared outside the repository', expected: resolved('global:document') },
      { label: 'a property of a global', expected: resolved('global:window.document') },
    ],
  },
  {
    code: [
      'class Svc {',
      '  bus = new Emitter();',
      '  constructor(private readonly injected: Emitter) {}',
      '  run(): void { probe(this.bus); probe(this.injected); probe(this); }',
      '  later(): void { const f = (): void => probe(this); f(); }',
      '}',
    ].join('\n'),
    probes: [
      {
        label: 'a class property through this',
        expected: resolved('consumer.ts:Svc.bus', 'medium'),
      },
      {
        label: 'a parameter property through this',
        expected: resolved('consumer.ts:Svc.injected', 'medium'),
      },
      { label: 'this inside a class', expected: resolved('consumer.ts:Svc', 'medium') },
      {
        label: 'this inside an arrow function in a method',
        expected: resolved('consumer.ts:Svc', 'medium'),
      },
    ],
  },
  {
    code: 'const svc = new Svc(local); probe(svc.bus);',
    probes: [
      {
        label: 'a class property through an instance',
        expected: resolved('consumer.ts:Svc.bus', 'medium'),
      },
    ],
  },
  {
    code: 'const app = { events: { bus: new Emitter() } }; probe(app.events.bus); probe(app["events"]);',
    probes: [
      {
        label: 'a nested object-literal property',
        expected: resolved('consumer.ts:app.events.bus'),
      },
      {
        label: 'a bracket access on an object literal',
        expected: resolved('consumer.ts:app.events'),
      },
    ],
  },
  {
    code: 'interface Ctx { bus: Emitter } function use(a: Ctx, b: Ctx): void { probe(a.bus); probe(b.bus); }',
    probes: [
      {
        label: 'a property of the first parameter',
        expected: resolved('consumer.ts:use.a.bus', 'medium'),
      },
      {
        label: 'a property of the second parameter',
        expected: resolved('consumer.ts:use.b.bus', 'medium'),
      },
    ],
  },
  {
    code: 'class StaticBus { static on(): void {} } probe(StaticBus);',
    probes: [
      { label: 'a class used as a static receiver', expected: resolved('consumer.ts:StaticBus') },
    ],
  },
  {
    code: 'probe(bus!); probe((bus));',
    probes: [
      { label: 'a non-null assertion', expected: resolved('bus.ts:bus') },
      { label: 'a parenthesized receiver', expected: resolved('bus.ts:bus') },
    ],
  },
  {
    code: 'function plain(this: unknown): void { probe(this); }',
    probes: [{ label: 'this in a plain function', expected: unknown }],
  },
  {
    code: 'const holder = { m(): void { probe(this); } }; void holder;',
    probes: [{ label: 'this in an object literal method', expected: unknown }],
  },
  { code: 'probe(getBus());', probes: [{ label: 'a call result', expected: unknown }] },
  { code: 'probe(missing);', probes: [{ label: 'an unresolved identifier', expected: unknown }] },
  {
    code: 'probe(ghost);',
    probes: [{ label: 'an import that cannot be resolved', expected: unknown }],
  },
];

describe('ReceiverResolver', () => {
  const cases = GROUPS.flatMap((group) => group.probes);
  let identities: ReceiverIdentity[] = [];
  const siblings: Record<string, ReceiverIdentity> = {};
  let fixture: RepositoryFixture | undefined;

  beforeAll(() => {
    const code = [PREAMBLE, ...GROUPS.map((group) => group.code)].join('\n');
    fixture = createRepositoryFixture({ ...FILES, 'consumer.ts': code });
    const resolver = new ReceiverResolver(fixture.repository);

    identities = callArguments(fixture.repository, 'consumer.ts').map((arg) =>
      resolver.resolve(arg),
    );
    for (const file of ['a.ts', 'b.ts', 'other-consumer.ts']) {
      const [arg] = callArguments(fixture.repository, file);
      if (arg) siblings[file] = resolver.resolve(arg);
    }
  });
  afterAll(() => fixture?.cleanup());

  it('found one receiver per expectation', () => {
    expect(identities).toHaveLength(cases.length);
  });

  it.each(cases.map((c, index) => [c.label, index] as const))('resolves %s', (_label, index) => {
    expect(identities[index]).toMatchObject(cases[index]?.expected ?? {});
  });

  it('marks resolved identities as compiler-resolved', () => {
    expect(identities[0]).toMatchObject({ kind: 'resolved', evidence: 'ts-program' });
  });

  it('gives the same emitter the same scope in every file that imports it', () => {
    expect(siblings['other-consumer.ts']).toMatchObject({ scope: 'bus.ts:bus' });
    expect(siblings['other-consumer.ts']).toEqual(identities[0]);
  });

  it('keeps same-named locals in different files apart', () => {
    expect(siblings['a.ts']).toMatchObject({ scope: 'a.ts:bus' });
    expect(siblings['b.ts']).toMatchObject({ scope: 'b.ts:bus' });
  });

  it('keeps two parameters of the same type apart', () => {
    const first =
      identities[cases.findIndex((c) => c.label === 'a property of the first parameter')];
    const second =
      identities[cases.findIndex((c) => c.label === 'a property of the second parameter')];
    expect(first).not.toEqual(second);
  });
});

describe('qualifyReceiver', () => {
  const QUALIFY_SOURCE = `
declare function probe(value: unknown): void;
class Emitter { on(e: string, f: () => void): void {} emit(e: string): void {} }
class Child extends Emitter {}
declare const emitter: Emitter;
declare const target: EventTarget;
declare const store: { dispatch(action: unknown): void; subscribe(listener: () => void): void };
declare const jq: { on(e: string, f: () => void): void; trigger(e: string): void };
declare const untyped: any;
declare const maybe: Emitter | undefined;
declare const child: Child;
declare const bare: { emit(e: string): void };
declare const holder: { bus: Emitter };
probe(emitter); probe(target); probe(store); probe(jq); probe(untyped);
probe(maybe); probe(child); probe(bare); probe(holder.bus);
`;
  const NAMES = [
    'emitter',
    'target',
    'store',
    'jq',
    'untyped',
    'maybe',
    'child',
    'bare',
    'holder.bus',
  ];

  let fixture: RepositoryFixture | undefined;

  const run = (
    rule: ReceiverRule,
    catalog = new EventProtocolCatalog(),
  ): Record<string, ReceiverQualification> => {
    if (!fixture) throw new Error('fixture not built');
    const { repository } = fixture;
    const receivers = callArguments(repository, 'qualify.ts');
    return Object.fromEntries(
      receivers.map((receiver, index) => [
        NAMES[index] ?? String(index),
        qualifyReceiver(rule, receiver, catalog, repository.checker),
      ]),
    );
  };

  const qualifying = (results: Record<string, ReceiverQualification>): string[] =>
    Object.entries(results)
      .filter(([, result]) => result.qualifies)
      .map(([name]) => name);

  beforeAll(() => {
    // Strict null checks keep `Emitter | undefined` a real union instead of collapsing to `Emitter`.
    fixture = createRepositoryFixture({ 'qualify.ts': QUALIFY_SOURCE }, { strict: true });
  });
  afterAll(() => fixture?.cleanup());

  it('accepts a receiver of any kind when the rule is "any"', () => {
    const results = run('any');
    expect(qualifying(results)).toEqual(NAMES);
    expect(results['untyped']?.evidence).toBe('ast');
  });

  it('accepts emitters and targets, and rejects look-alikes, for "event-like"', () => {
    const results = run('event-like');

    expect(qualifying(results)).toEqual(['emitter', 'target', 'maybe', 'child', 'holder.bus']);
    expect(results['emitter']?.evidence).toBe('ts-program');
  });

  it('explains why a receiver was rejected', () => {
    const results = run('event-like');

    expect(results['untyped']?.reason).toBe('receiver type is not known');
    expect(results['store']?.reason).toBe(
      'receiver type lacks both a subscribe method and an emit or dispatch method',
    );
    expect(results['jq']?.qualifies).toBe(false);
    expect(results['bare']?.qualifies).toBe(false);
  });

  it('follows the active catalog, so configured methods count as evidence', () => {
    const catalog = new EventProtocolCatalog({
      methods: [
        { method: 'subscribe', direction: 'subscribe', eventArg: 0 },
        { method: 'trigger', direction: 'emit', eventArg: 0 },
      ],
    });

    expect(qualifying(run('event-like', catalog))).toEqual([
      'emitter',
      'target',
      'store',
      'jq',
      'maybe',
      'child',
      'holder.bus',
    ]);
  });

  it('matches a names rule against the receiver expression, recording config evidence', () => {
    const results = run({ names: ['emitter', 'bus'] });

    expect(qualifying(results)).toEqual(['emitter', 'holder.bus']);
    expect(results['emitter']?.evidence).toBe('config');
  });

  it('matches a types rule against the type, its base types, and non-null unions', () => {
    const results = run({ types: ['Emitter'] });

    expect(qualifying(results)).toEqual(['emitter', 'maybe', 'child', 'holder.bus']);
    expect(results['store']?.reason).toBe('receiver matches neither names nor types');
  });

  it('accepts a receiver that matches either part of a combined rule', () => {
    expect(qualifying(run({ names: ['store'], types: ['Child'] }))).toEqual(['store', 'child']);
  });
});
