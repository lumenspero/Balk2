import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  callArguments,
  createRepositoryFixture,
  type RepositoryFixture,
} from '../testing/repository-fixture.js';
import { readListenerOptions, type ListenerFlags } from './event-options.js';

vi.setConfig({ testTimeout: 30_000 });

interface Case {
  readonly label: string;
  /** One statement containing exactly one `probe(...)` call. */
  readonly code: string;
  readonly flags: ListenerFlags;
  readonly direction?: 'subscribe' | 'unsubscribe';
}

const PREAMBLE = `
declare function probe(value: unknown): void;
declare const controller: AbortController;
declare const someBoolean: boolean;
declare const LITERAL_TRUE: true;
declare const typed: AddEventListenerOptions;
const ONCE = true;
const NOT_ONCE = false;
let mutableFlag = true;
const once = true;
const OPTIONS = { once: true, passive: true };
const BASE = { capture: true };
`;

const CASES: readonly Case[] = [
  { label: 'once', code: 'probe({ once: true });', flags: { once: true } },
  { label: 'capture', code: 'probe({ capture: true });', flags: { capture: true } },
  { label: 'passive', code: 'probe({ passive: true });', flags: { passive: true } },
  {
    label: 'all three flags together',
    code: 'probe({ once: true, capture: true, passive: true });',
    flags: { once: true, capture: true, passive: true },
  },
  { label: 'a flag explicitly false', code: 'probe({ once: false });', flags: {} },
  { label: 'string-literal keys', code: "probe({ 'once': true });", flags: { once: true } },

  { label: 'the legacy true capture argument', code: 'probe(true);', flags: { capture: true } },
  { label: 'the legacy false capture argument', code: 'probe(false);', flags: {} },

  { label: 'a signal', code: 'probe({ signal: controller.signal });', flags: { abortable: true } },
  {
    label: 'a shorthand signal',
    code: 'const signal = controller.signal; probe({ signal });',
    flags: { abortable: true },
  },
  { label: 'a signal that is undefined', code: 'probe({ signal: undefined });', flags: {} },
  { label: 'a signal that is null', code: 'probe({ signal: null });', flags: {} },

  { label: 'a const flag', code: 'probe({ once: ONCE });', flags: { once: true } },
  { label: 'a const flag that is false', code: 'probe({ once: NOT_ONCE });', flags: {} },
  { label: 'a shorthand const flag', code: 'probe({ once });', flags: { once: true } },
  {
    label: 'a flag with a literal type',
    code: 'probe({ once: LITERAL_TRUE });',
    flags: { once: true },
  },
  { label: 'a mutable flag', code: 'probe({ once: mutableFlag });', flags: {} },
  { label: 'a boolean of unknown value', code: 'probe({ once: someBoolean });', flags: {} },

  {
    label: 'an options object held in a const',
    code: 'probe(OPTIONS);',
    flags: { once: true, passive: true },
  },
  {
    label: 'an options object with a type assertion',
    code: 'probe({ once: true } as AddEventListenerOptions);',
    flags: { once: true },
  },
  {
    label: 'a spread next to a literal flag',
    code: 'probe({ ...BASE, once: true });',
    flags: { once: true },
  },
  { label: 'a typed options value of unknown content', code: 'probe(typed);', flags: {} },
  { label: 'something that is not options', code: 'probe(() => 1);', flags: {} },
  { label: 'a number', code: 'probe(3);', flags: {} },

  {
    label: 'only capture when unsubscribing',
    code: 'probe({ once: true, capture: true, passive: true, signal: controller.signal });',
    flags: { capture: true },
    direction: 'unsubscribe',
  },
  {
    label: 'the legacy capture argument when unsubscribing',
    code: 'probe(true);',
    flags: { capture: true },
    direction: 'unsubscribe',
  },
  {
    label: 'a signal when unsubscribing',
    code: 'probe({ signal: controller.signal });',
    flags: {},
    direction: 'unsubscribe',
  },
];

describe('readListenerOptions', () => {
  let results: ListenerFlags[] = [];
  let fixture: RepositoryFixture | undefined;

  beforeAll(() => {
    fixture = createRepositoryFixture({
      'options.ts': [PREAMBLE, ...CASES.map((c) => c.code)].join('\n'),
    });
    const { repository } = fixture;
    const args = callArguments(repository, 'options.ts');
    if (args.length !== CASES.length) {
      throw new Error(`Expected ${CASES.length} probes, found ${args.length}`);
    }
    results = args.map((arg, index) =>
      readListenerOptions(arg, repository.checker, CASES[index]?.direction ?? 'subscribe'),
    );
  });
  afterAll(() => fixture?.cleanup());

  it.each(CASES.map((c, index) => [c.label, index] as const))('reads %s', (_label, index) => {
    expect(results[index]).toEqual(CASES[index]?.flags);
  });

  it('reports nothing when there is no options argument', () => {
    if (!fixture) throw new Error('fixture not built');
    expect(readListenerOptions(undefined, fixture.repository.checker, 'subscribe')).toEqual({});
  });
});
