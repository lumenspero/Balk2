import { describe, expect, it } from 'vitest';
import {
  appliesTo,
  JS_TS_LANGUAGES,
  PYTHON_LANGUAGES,
  RUST_LANGUAGES,
  scopeEvents,
  scopeRegistries,
} from './protocol-scope.js';
import { normalizeProtocolsConfig } from './protocols-config.js';

describe('protocol entries: loading the languages tag', () => {
  it('keeps a callback tagged with a language that reads callbacks', () => {
    const { config, problems } = normalizeProtocolsConfig({
      callbacks: [{ function: 'run', callbackArg: 0, languages: ['typescript'] }],
    });
    expect(config?.callbacks?.[0]?.languages).toEqual(['typescript']);
    expect(problems).toEqual([]);
  });

  it('leaves an untagged entry without a languages field', () => {
    const { config } = normalizeProtocolsConfig({
      callbacks: [{ function: 'run', callbackArg: 0 }],
    });
    expect(config?.callbacks?.[0]).toEqual({ function: 'run', callbackArg: 0 });
  });

  it('drops an entry tagged only with a language that does not read its list', () => {
    const { config, problems } = normalizeProtocolsConfig({
      callbacks: [{ function: 'run', callbackArg: 0, languages: ['python'] }],
    });
    expect(config?.callbacks).toBeUndefined();
    expect(problems).toContainEqual({
      path: 'protocols.callbacks[0].languages',
      message: 'python does not read callbacks yet; ignored for python',
    });
    expect(problems).toContainEqual({
      path: 'protocols.callbacks[0]',
      message: 'applies to no language that reads it; entry ignored',
    });
  });

  it('keeps the reading languages of an event method and reports the rest', () => {
    const { config, problems } = normalizeProtocolsConfig({
      events: {
        methods: [
          {
            method: 'publish',
            direction: 'emit',
            eventArg: 0,
            languages: ['python', 'typescript'],
          },
        ],
      },
    });
    expect(config?.events?.methods?.[0]?.languages).toEqual(['typescript']);
    expect(problems).toContainEqual({
      path: 'protocols.events.methods[0].languages',
      message: 'python does not read events.methods yet; ignored for python',
    });
  });

  it('accepts a registry method tagged for several languages, in the order given', () => {
    const { config, problems } = normalizeProtocolsConfig({
      registries: {
        methods: [
          { method: 'register', direction: 'register', keyArg: 0, languages: ['rust', 'python'] },
        ],
      },
    });
    expect(config?.registries?.methods?.[0]?.languages).toEqual(['rust', 'python']);
    expect(problems).toEqual([]);
  });

  it('keeps a resource tagged for python and reports nothing', () => {
    const { config, problems } = normalizeProtocolsConfig({
      resources: [{ function: 'render', specifierArg: 0, languages: ['python'] }],
    });
    expect(config?.resources?.[0]?.languages).toEqual(['python']);
    expect(problems).toEqual([]);
  });

  it('reports an unknown language name and ignores the entry', () => {
    const { config, problems } = normalizeProtocolsConfig({
      resources: [{ function: 'render', specifierArg: 0, languages: ['cobol'] }],
    });
    expect(config?.resources).toBeUndefined();
    expect(problems).toContainEqual({
      path: 'protocols.resources[0].languages[0]',
      message: 'must be one of javascript, typescript, python, rust; entry ignored',
    });
  });

  it('reports a languages value that is not a list and ignores the entry', () => {
    const { config, problems } = normalizeProtocolsConfig({
      callbacks: [{ function: 'run', callbackArg: 0, languages: 'python' }],
    });
    expect(config?.callbacks).toBeUndefined();
    expect(problems).toContainEqual({
      path: 'protocols.callbacks[0].languages',
      message: 'must be a non-empty list of javascript, typescript, python, rust; entry ignored',
    });
  });
});

describe('protocol entries: filtering for a front end', () => {
  const entries = [
    { function: 'shared' },
    { function: 'web', languages: ['typescript' as const] },
    { function: 'py', languages: ['python' as const] },
  ];

  it('applies an untagged entry to every front end', () => {
    expect(appliesTo(entries, JS_TS_LANGUAGES)?.map((e) => e.function)).toEqual(['shared', 'web']);
    expect(appliesTo(entries, PYTHON_LANGUAGES)?.map((e) => e.function)).toEqual(['shared', 'py']);
    expect(appliesTo(entries, RUST_LANGUAGES)?.map((e) => e.function)).toEqual(['shared']);
  });

  it('keeps an absent list absent', () => {
    expect(appliesTo(undefined, JS_TS_LANGUAGES)).toBeUndefined();
  });

  it('treats javascript and typescript as one family', () => {
    const tagged = [{ function: 'js', languages: ['javascript' as const] }];
    expect(appliesTo(tagged, JS_TS_LANGUAGES)).toHaveLength(1);
  });

  it('filters the methods of an events section and keeps its other fields', () => {
    const events = {
      builtIns: false,
      methods: [
        { method: 'a', languages: ['typescript' as const] },
        { method: 'b', languages: ['python' as const] },
      ],
    };
    const scoped = scopeEvents(events, JS_TS_LANGUAGES);
    expect(scoped?.builtIns).toBe(false);
    expect(scoped?.methods?.map((m) => m.method)).toEqual(['a']);
  });

  it('filters every list of a registries section for one front end', () => {
    const registries = {
      methods: [{ method: 'm', languages: ['rust' as const] }],
      attributes: [{ name: 'tauri::command', languages: ['python' as const, 'rust' as const] }],
      decorators: [{ name: 'd' }],
    };
    const forRust = scopeRegistries(registries, RUST_LANGUAGES);
    expect(forRust?.methods?.map((m) => m.method)).toEqual(['m']);
    expect(forRust?.attributes?.map((a) => a.name)).toEqual(['tauri::command']);
    expect(forRust?.decorators?.map((d) => d.name)).toEqual(['d']);

    const forPython = scopeRegistries(registries, PYTHON_LANGUAGES);
    expect(forPython?.methods).toEqual([]);
    expect(forPython?.attributes?.map((a) => a.name)).toEqual(['tauri::command']);
  });
});
