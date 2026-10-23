import { describe, expect, it } from 'vitest';
import type { RegistryFact, RegistryKeyFact } from '../../facts/types.js';
import { analyzePythonCalls } from './calls.js';
import { createPythonRegistryCollector } from './registry-facts.js';
import type { RegistryNameInjectionRule } from '../registry-protocols.js';
import { createImportResolver } from './modules/import-resolution.js';
import { createSymbolResolver } from './modules/module-exports.js';
import { ModuleIndex } from './modules/module-index.js';

function collect(
  files: Record<string, string>,
  nameInjection: readonly RegistryNameInjectionRule[] = [],
): RegistryFact[] {
  const index = new ModuleIndex(Object.keys(files));
  const readText = (p: string): string => files[p] ?? '';
  const imports = createImportResolver(index, { roots: ['.'], readText });
  const symbols = createSymbolResolver({ resolver: imports, readText });
  const ctx = { symbols, imports };
  const sources = Object.entries(files).map(([filePath, source]) => ({ filePath, source }));
  const collector = createPythonRegistryCollector(nameInjection);
  analyzePythonCalls(sources, ctx, {}, collector.observer);
  return collector.facts();
}

function keyText(key: RegistryKeyFact): string {
  if (key.kind === 'static') return key.name;
  return key.kind === 'dynamic' ? `dynamic:${key.reason}` : 'not-a-name';
}

/** One line per fact: a declaration, or `owner relationship key registry [-> target] [internal]`. */
function lines(
  files: Record<string, string>,
  nameInjection: readonly RegistryNameInjectionRule[] = [],
): string[] {
  return collect(files, nameInjection).map((f) => {
    if (f.kind === 'registry-injection')
      return `${f.owner} injects ${keyText(f.key)} ${f.registry}`;
    if (f.kind === 'registry-declaration') {
      return `declare ${f.registry} ${keyText(f.key)} -> ${f.target}`;
    }
    if (f.kind !== 'registry-call') return `other ${f.kind}`;
    const scope = f.receiver.identity.kind === 'resolved' ? f.receiver.identity.scope : '?';
    const target = f.target === undefined ? '' : ` -> ${f.target}`;
    const internal = f.receiver.internal ? ' internal' : '';
    return `${f.owner} ${f.relationship} ${keyText(f.key)} ${scope}${target}${internal}`;
  });
}

const CLASSES = 'class User:\n    pass\n\n\nclass Admin:\n    pass\n\n\n';

describe('python registry facts: dictionaries', () => {
  it('reads a module-level dict display of symbols as declarations', () => {
    expect(
      lines({
        'm.py': `${CLASSES}REGISTRY = {'user': User, 'admin': Admin}\n`,
      }),
    ).toEqual([
      'declare m.py:REGISTRY user -> m.py:User',
      'declare m.py:REGISTRY admin -> m.py:Admin',
    ]);
  });

  it('reads a literal-key store as a registration, and a subscript and get as lookups', () => {
    expect(
      lines({
        'm.py': `${CLASSES}REG = dict()\nREG['user'] = User\n\n\ndef find():\n    return REG['user'], REG.get('user')\n`,
      }),
    ).toEqual([
      'm.py registers user m.py:REG -> m.py:User',
      'm.py:find resolves user m.py:REG',
      'm.py:find resolves user m.py:REG',
    ]);
  });

  it('reads a non-literal key as a dynamic lookup', () => {
    expect(
      lines({
        'm.py': `REG = {}\n\n\ndef find(name):\n    return REG[name]\n`,
      }),
    ).toEqual(['m.py:find resolves dynamic:key is not a literal m.py:REG']);
  });

  it('gives no registration for a store of a value that is not a repository symbol', () => {
    expect(lines({ 'm.py': `REG = {}\nREG['x'] = 1\n` })).toEqual([]);
  });

  it('gives no fact for a receiver the call pass does not type as a dict', () => {
    expect(
      lines({
        'm.py': `class Box:\n    def __getitem__(self, k):\n        return k\n\n\nb = Box()\nvalue = b['x']\n`,
      }),
    ).toEqual([]);
  });

  it('marks a dict built inside a function as internal, with a function-local identity', () => {
    expect(
      lines({
        'm.py': `${CLASSES}def build():\n    local = {}\n    local['a'] = User\n`,
      }),
    ).toEqual(['m.py:build registers a m.py:build.local -> m.py:User internal']);
  });
});

describe('python registry facts: repository registries', () => {
  const REGISTRY_CLASS =
    'class Registry:\n    def register(self, key, value):\n        return value\n\n    def get(self, key):\n        return key\n\n\n';

  it('reads register calls and lookups on a repository registry', () => {
    expect(
      lines({
        'm.py': `${CLASSES}${REGISTRY_CLASS}registry = Registry()\nregistry.register('user', User)\n\n\ndef load():\n    return registry.get('user')\n`,
      }),
    ).toEqual([
      'm.py registers user m.py:registry -> m.py:User',
      'm.py:load resolves user m.py:registry',
    ]);
  });

  it('reads a decorator registration as a declaration of the decorated class', () => {
    expect(
      lines({
        'm.py': `${REGISTRY_CLASS}registry = Registry()\n\n\n@registry.register('user')\nclass User:\n    pass\n`,
      }),
    ).toEqual(['declare m.py:registry user -> m.py:User']);
  });

  it('gives no fact for a class without a register method', () => {
    expect(
      lines({
        'm.py': `class Box:\n    def get(self, key):\n        return key\n\n\nbox = Box()\nvalue = box.get('x')\n`,
      }),
    ).toEqual([]);
  });
});

describe('python registry facts: parameter-name injection (pytest fixtures)', () => {
  const FIXTURES: RegistryNameInjectionRule[] = [
    { registry: 'fixtures', decorator: 'pytest.fixture' },
  ];

  it('declares a decorated function as a fixture and injects a parameter of its name', () => {
    expect(
      lines(
        {
          'test_app.py':
            'import pytest\n\n\n@pytest.fixture\ndef user_repo():\n    return 1\n\n\ndef test_load(user_repo):\n    return user_repo\n',
        },
        FIXTURES,
      ),
    ).toEqual([
      'declare fixtures user_repo -> test_app.py:user_repo',
      'test_app.py:test_load injects user_repo fixtures',
    ]);
  });

  it('injects nothing for a parameter that no fixture declares', () => {
    expect(
      lines({ 'test_app.py': 'def test_load(user_repo):\n    return user_repo\n' }, FIXTURES),
    ).toEqual([]);
  });

  it('declares nothing for a function without the rule decorator', () => {
    expect(
      lines(
        {
          'test_app.py':
            'def helper():\n    return 1\n\n\ndef test_load(helper):\n    return helper\n',
        },
        FIXTURES,
      ),
    ).toEqual([]);
  });
});
