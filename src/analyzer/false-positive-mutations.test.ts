import { describe, expect, it, vi } from 'vitest';
import type { ConnectionMap } from '../types.js';
import { analyzeFiles, hasRelationship } from '../testing/parity-metrics.js';

// Each case analyzes a repository and runs the full pipeline, so keep the default 5s limit out of the way.
vi.setConfig({ testTimeout: 60_000 });

/**
 * False-positive mutation tests (V3 Phase 16.3). Each case has a base program that makes a
 * connection, and a mutant of it with exactly one fact changed. The base must connect, which keeps
 * the mutant from passing vacuously, and the mutant must not. Every case has a counterpart in each
 * language, or a Not applicable reason from the capability matrix.
 */

type Files = Readonly<Record<string, string>>;

interface Mutation {
  readonly name: string;
  /** Whether the connection exists in this map. */
  readonly connected: (map: ConnectionMap) => boolean;
  readonly base: Files;
  readonly mutant: Files;
}

interface Case {
  readonly name: string;
  readonly javascript: Mutation;
  readonly python: Mutation;
  /** Null when the capability matrix marks Rust Not applicable, with its reason. */
  readonly rust: Mutation | { readonly notApplicable: string };
}

const CARGO = (name: string, dependencies = ''): string =>
  `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\ncrate-type = ["cdylib"]\n${dependencies}`;

/** Binding-mechanism edges leaving a file, for one mechanism. */
function bindingEdgesFrom(map: ConnectionMap, file: string, mechanism: string): number {
  return map.relationships.filter(
    (r) =>
      (r.from === file || r.from.startsWith(`${file}:`)) &&
      (r.metadata as Record<string, unknown> | undefined)?.mechanism === mechanism,
  ).length;
}

const CASES: readonly Case[] = [
  {
    name: 'same-named functions: a call reaches the function its import names, not a sibling',
    javascript: {
      name: 'base imports parse from a.ts; mutant drops the import',
      connected: (m) => hasRelationship(m, 'calls main.ts:run -> a.ts:parse'),
      base: {
        'a.ts': 'export function parse(): number {\n  return 1;\n}\n',
        'b.ts': 'export function parse(): number {\n  return 2;\n}\n',
        'main.ts':
          "import { parse } from './a.js';\n\nexport function run(): number {\n  return parse();\n}\n",
      },
      mutant: {
        'a.ts': 'export function parse(): number {\n  return 1;\n}\n',
        'b.ts': 'export function parse(): number {\n  return 2;\n}\n',
        'main.ts': 'export function run(): number {\n  return parse();\n}\n',
      },
    },
    python: {
      name: 'base imports parse from a; mutant drops the import',
      connected: (m) => hasRelationship(m, 'calls main.py:run -> a.py:parse'),
      base: {
        'a.py': 'def parse():\n    return 1\n',
        'b.py': 'def parse():\n    return 2\n',
        'main.py': 'from a import parse\n\n\ndef run():\n    return parse()\n',
      },
      mutant: {
        'a.py': 'def parse():\n    return 1\n',
        'b.py': 'def parse():\n    return 2\n',
        'main.py': 'def run():\n    return parse()\n',
      },
    },
    rust: {
      name: 'base calls a::parse; mutant calls parse with no use in scope',
      connected: (m) => hasRelationship(m, 'calls src/lib.rs:run -> src/a.rs:parse'),
      base: {
        'Cargo.toml': CARGO('demo'),
        'src/lib.rs': 'pub mod a;\npub mod b;\n\npub fn run() -> i32 {\n    a::parse()\n}\n',
        'src/a.rs': 'pub fn parse() -> i32 {\n    1\n}\n',
        'src/b.rs': 'pub fn parse() -> i32 {\n    2\n}\n',
      },
      mutant: {
        'Cargo.toml': CARGO('demo'),
        'src/lib.rs': 'pub mod a;\npub mod b;\n\npub fn run() -> i32 {\n    parse()\n}\n',
        'src/a.rs': 'pub fn parse() -> i32 {\n    1\n}\n',
        'src/b.rs': 'pub fn parse() -> i32 {\n    2\n}\n',
      },
    },
  },
  {
    name: 'same method name on two types: a receiver of unknown type does not reach either',
    javascript: {
      name: 'base types the receiver as User; mutant types it any',
      connected: (m) => hasRelationship(m, 'calls main.ts:run -> user.ts:User.save'),
      base: {
        'user.ts':
          'export class User {\n  save(): void {}\n}\n\nexport class Other {\n  save(): void {}\n}\n',
        'main.ts':
          "import { User } from './user.js';\n\nexport function run(thing: User): void {\n  thing.save();\n}\n",
      },
      mutant: {
        'user.ts':
          'export class User {\n  save(): void {}\n}\n\nexport class Other {\n  save(): void {}\n}\n',
        'main.ts':
          "import { User } from './user.js';\n\nexport function run(thing: any): void {\n  thing.save();\n}\n",
      },
    },
    python: {
      name: 'base annotates the receiver as User; mutant leaves it unannotated',
      connected: (m) => hasRelationship(m, 'calls main.py:run -> user.py:User.save'),
      base: {
        'user.py': 'class User:\n    def save(self):\n        return None\n',
        'other.py': 'class Other:\n    def save(self):\n        return None\n',
        'main.py': 'from user import User\n\n\ndef run(thing: User):\n    thing.save()\n',
      },
      mutant: {
        'user.py': 'class User:\n    def save(self):\n        return None\n',
        'other.py': 'class Other:\n    def save(self):\n        return None\n',
        'main.py': 'from user import User\n\n\ndef run(thing):\n    thing.save()\n',
      },
    },
    rust: {
      name: 'base annotates the receiver as &User; mutant is generic with no bound',
      connected: (m) => hasRelationship(m, 'calls src/lib.rs:run -> src/lib.rs:User.save'),
      base: {
        'Cargo.toml': CARGO('demo'),
        'src/lib.rs':
          'pub struct User;\n\nimpl User {\n    pub fn save(&self) {}\n}\n\npub struct Other;\n\nimpl Other {\n    pub fn save(&self) {}\n}\n\npub fn run(thing: &User) {\n    thing.save();\n}\n',
      },
      mutant: {
        'Cargo.toml': CARGO('demo'),
        'src/lib.rs':
          'pub struct User;\n\nimpl User {\n    pub fn save(&self) {}\n}\n\npub struct Other;\n\nimpl Other {\n    pub fn save(&self) {}\n}\n\npub fn run<T>(thing: T) {\n    thing.save();\n}\n',
      },
    },
  },
  {
    name: 'the same key in two registries does not connect',
    javascript: {
      name: 'base looks the key up in the registry it was registered in; mutant looks it up in the other',
      connected: (m) => hasRelationship(m, 'resolves main.ts:load -> registry:main.ts:first#user'),
      base: {
        'main.ts':
          "export class User {}\n\nexport const first = new Map<string, unknown>();\nexport const second = new Map<string, unknown>();\n\nexport function register(): void {\n  first.set('user', User);\n}\n\nexport function load(): unknown {\n  return first.get('user');\n}\n",
      },
      mutant: {
        'main.ts':
          "export class User {}\n\nexport const first = new Map<string, unknown>();\nexport const second = new Map<string, unknown>();\n\nexport function register(): void {\n  first.set('user', User);\n}\n\nexport function load(): unknown {\n  return second.get('user');\n}\n",
      },
    },
    python: {
      name: 'base looks the key up in the registry it was registered in; mutant looks it up in the other',
      connected: (m) => hasRelationship(m, 'resolves main.py:load -> registry:main.py:first#user'),
      base: {
        'main.py':
          "class User:\n    pass\n\n\nfirst = {}\nsecond = {}\nfirst['user'] = User\n\n\ndef load():\n    return first['user']\n",
      },
      mutant: {
        'main.py':
          "class User:\n    pass\n\n\nfirst = {}\nsecond = {}\nfirst['user'] = User\n\n\ndef load():\n    return second['user']\n",
      },
    },
    rust: {
      name: 'base looks the key up in the map it was inserted into; mutant looks it up in the other',
      connected: (m) =>
        hasRelationship(m, 'resolves src/lib.rs:lookup -> registry:src/lib.rs:lookup.first#user'),
      base: {
        'Cargo.toml': CARGO('demo'),
        'src/lib.rs':
          'use std::collections::HashMap;\n\npub struct User;\n\npub fn lookup() -> Option<&\'static User> {\n    let mut first: HashMap<&\'static str, User> = HashMap::new();\n    let second: HashMap<&\'static str, User> = HashMap::new();\n    first.insert("user", User);\n    first.get("user")\n}\n',
      },
      mutant: {
        'Cargo.toml': CARGO('demo'),
        'src/lib.rs':
          'use std::collections::HashMap;\n\npub struct User;\n\npub fn lookup() -> Option<&\'static User> {\n    let mut first: HashMap<&\'static str, User> = HashMap::new();\n    let second: HashMap<&\'static str, User> = HashMap::new();\n    first.insert("user", User);\n    second.get("user")\n}\n',
      },
    },
  },
  {
    name: 'the same event name on two receivers does not connect',
    javascript: {
      name: 'base subscribes and emits on one receiver; mutant emits on the other',
      connected: (m) =>
        hasRelationship(m, 'emits main.ts:publish -> event:main.ts:a#ready') &&
        hasRelationship(m, 'subscribes main.ts:onReady -> event:main.ts:a#ready'),
      base: {
        'main.ts':
          "export class Bus {\n  on(name: string, listener: () => void): void {}\n  emit(name: string): void {}\n}\n\nexport const a = new Bus();\nexport const b = new Bus();\n\nexport function onReady(): void {}\n\nexport function start(): void {\n  a.on('ready', onReady);\n}\n\nexport function publish(): void {\n  a.emit('ready');\n}\n",
      },
      mutant: {
        'main.ts':
          "export class Bus {\n  on(name: string, listener: () => void): void {}\n  emit(name: string): void {}\n}\n\nexport const a = new Bus();\nexport const b = new Bus();\n\nexport function onReady(): void {}\n\nexport function start(): void {\n  a.on('ready', onReady);\n}\n\nexport function publish(): void {\n  b.emit('ready');\n}\n",
      },
    },
    python: {
      name: 'base subscribes and emits on one emitter; mutant emits on the other',
      connected: (m) =>
        hasRelationship(m, 'emits main.py:publish -> event:main.py:a#ready') &&
        hasRelationship(m, 'subscribes main.py:on_ready -> event:main.py:a#ready'),
      base: {
        'main.py':
          "from pyee import EventEmitter\n\na = EventEmitter()\nb = EventEmitter()\n\n\ndef on_ready():\n    return 1\n\n\ndef start():\n    a.on('ready', on_ready)\n\n\ndef publish():\n    a.emit('ready')\n",
      },
      mutant: {
        'main.py':
          "from pyee import EventEmitter\n\na = EventEmitter()\nb = EventEmitter()\n\n\ndef on_ready():\n    return 1\n\n\ndef start():\n    a.on('ready', on_ready)\n\n\ndef publish():\n    b.emit('ready')\n",
      },
    },
    rust: {
      notApplicable:
        'Rust channels connect by passing values, not by name, so a name-keyed channel does not exist (capability matrix, row 13).',
    },
  },
  {
    name: 'a local that shadows an imported function does not connect the call',
    javascript: {
      name: 'base calls the import; mutant shadows it with a local',
      connected: (m) => hasRelationship(m, 'calls main.ts:run -> util.ts:help'),
      base: {
        'util.ts': 'export function help(): number {\n  return 1;\n}\n',
        'main.ts':
          "import { help } from './util.js';\n\nexport function run(): number {\n  return help();\n}\n",
      },
      mutant: {
        'util.ts': 'export function help(): number {\n  return 1;\n}\n',
        'main.ts':
          "import { help } from './util.js';\n\nexport function run(): number {\n  const help = (): number => 2;\n  return help();\n}\n",
      },
    },
    python: {
      name: 'base calls the import; mutant shadows it with a local',
      connected: (m) => hasRelationship(m, 'calls main.py:run -> util.py:helper'),
      base: {
        'util.py': 'def helper():\n    return 1\n',
        'main.py': 'from util import helper\n\n\ndef run():\n    return helper()\n',
      },
      mutant: {
        'util.py': 'def helper():\n    return 1\n',
        'main.py':
          'from util import helper\n\n\ndef run():\n    helper = lambda: 2\n    return helper()\n',
      },
    },
    rust: {
      name: 'base calls the import; mutant shadows it with a closure',
      connected: (m) => hasRelationship(m, 'calls src/main_mod.rs:run -> src/util.rs:help'),
      base: {
        'Cargo.toml': CARGO('demo'),
        'src/lib.rs': 'pub mod util;\npub mod main_mod;\n',
        'src/util.rs': 'pub fn help() -> i32 {\n    1\n}\n',
        'src/main_mod.rs': 'use crate::util::help;\n\npub fn run() -> i32 {\n    help()\n}\n',
      },
      mutant: {
        'Cargo.toml': CARGO('demo'),
        'src/lib.rs': 'pub mod util;\npub mod main_mod;\n',
        'src/util.rs': 'pub fn help() -> i32 {\n    1\n}\n',
        'src/main_mod.rs':
          'use crate::util::help;\n\npub fn run() -> i32 {\n    let help = || 2;\n    help()\n}\n',
      },
    },
  },
  {
    name: 'a module named like a binding, without the binding dependency, gets no edge',
    javascript: {
      name: 'base has the wasm-bindgen dependency; mutant drops it',
      connected: (m) => bindingEdgesFrom(m, 'web/src/search.ts', 'wasm-bindgen') > 0,
      base: {
        'Cargo.toml': CARGO('core', '\n[dependencies]\nwasm-bindgen = "0.2"\n'),
        'src/lib.rs':
          '#[wasm_bindgen]\npub fn search(query: &str) -> String {\n    query.to_string()\n}\n',
        'web/src/search.ts':
          "import { search } from '../../pkg/core.js';\n\nexport function run(query: string): string {\n  return search(query);\n}\n",
      },
      mutant: {
        'Cargo.toml': CARGO('core'),
        'src/lib.rs':
          '#[wasm_bindgen]\npub fn search(query: &str) -> String {\n    query.to_string()\n}\n',
        'web/src/search.ts':
          "import { search } from '../../pkg/core.js';\n\nexport function run(query: string): string {\n  return search(query);\n}\n",
      },
    },
    python: {
      name: 'base has the pyo3 dependency; mutant drops it',
      connected: (m) => bindingEdgesFrom(m, 'app/use.py', 'pyo3') > 0,
      base: {
        'Cargo.toml': CARGO('fastpath', '\n[dependencies]\npyo3 = "0.22"\n'),
        'src/lib.rs':
          "#[pyfunction]\nfn parse(text: &str) -> usize {\n    text.len()\n}\n\n#[pymodule]\nfn _fastpath(m: &Bound<'_, PyModule>) -> PyResult<()> {\n    m.add_function(wrap_pyfunction!(parse, m)?)?;\n    Ok(())\n}\n",
        'pyproject.toml':
          '[build-system]\nrequires = ["maturin>=1,<2"]\nbuild-backend = "maturin"\n\n[tool.maturin]\nmodule-name = "app._fastpath"\n',
        'app/use.py': 'from app._fastpath import parse\n\nprint(parse("x"))\n',
      },
      mutant: {
        'Cargo.toml': CARGO('fastpath'),
        'src/lib.rs':
          "#[pyfunction]\nfn parse(text: &str) -> usize {\n    text.len()\n}\n\n#[pymodule]\nfn _fastpath(m: &Bound<'_, PyModule>) -> PyResult<()> {\n    m.add_function(wrap_pyfunction!(parse, m)?)?;\n    Ok(())\n}\n",
        'pyproject.toml':
          '[build-system]\nrequires = ["maturin>=1,<2"]\nbuild-backend = "maturin"\n\n[tool.maturin]\nmodule-name = "app._fastpath"\n',
        'app/use.py': 'from app._fastpath import parse\n\nprint(parse("x"))\n',
      },
    },
    rust: {
      name: 'base has the wasm-bindgen dependency; mutant drops it',
      connected: (m) => bindingEdgesFrom(m, 'src/lib.rs', 'wasm-bindgen') > 0,
      base: {
        'Cargo.toml': CARGO('core', '\n[dependencies]\nwasm-bindgen = "0.2"\n'),
        'src/lib.rs':
          '#[wasm_bindgen(module = "/js/greet.js")]\nextern "C" {\n    fn greet(name: &str);\n}\n\n#[wasm_bindgen]\npub fn hello() {\n    greet("world");\n}\n',
        'js/greet.js': 'export function greet(name) {\n  console.log(name);\n}\n',
      },
      mutant: {
        'Cargo.toml': CARGO('core'),
        'src/lib.rs':
          '#[wasm_bindgen(module = "/js/greet.js")]\nextern "C" {\n    fn greet(name: &str);\n}\n\n#[wasm_bindgen]\npub fn hello() {\n    greet("world");\n}\n',
        'js/greet.js': 'export function greet(name) {\n  console.log(name);\n}\n',
      },
    },
  },
];

function isNotApplicable(
  rust: Mutation | { readonly notApplicable: string },
): rust is { readonly notApplicable: string } {
  return 'notApplicable' in rust;
}

describe('false-positive mutations (V3 Phase 16.3)', () => {
  for (const testCase of CASES) {
    describe(testCase.name, () => {
      const languages: ReadonlyArray<readonly [string, Mutation]> = [
        ['javascript', testCase.javascript],
        ['python', testCase.python],
      ];
      for (const [language, mutation] of languages) {
        it(`${language}: ${mutation.name}`, () => {
          const base = analyzeFiles(mutation.base).map;
          expect(mutation.connected(base), 'base connects, so the mutant is not vacuous').toBe(
            true,
          );
          const mutant = analyzeFiles(mutation.mutant).map;
          expect(mutation.connected(mutant), 'mutant must not connect').toBe(false);
        });
      }

      if (isNotApplicable(testCase.rust)) {
        it.skip(`rust: not applicable, ${testCase.rust.notApplicable}`, () => undefined);
      } else {
        it(`rust: ${testCase.rust.name}`, () => {
          const rust = testCase.rust as Mutation;
          const base = analyzeFiles(rust.base).map;
          expect(rust.connected(base), 'base connects, so the mutant is not vacuous').toBe(true);
          const mutant = analyzeFiles(rust.mutant).map;
          expect(rust.connected(mutant), 'mutant must not connect').toBe(false);
        });
      }
    });
  }
});
