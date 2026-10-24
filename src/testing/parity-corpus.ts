import { assertUniqueNames, type CorpusScenario } from './corpus-types.js';

/**
 * Language-neutral parity scenarios. Each scenario has one rendition per language, written to mean
 * the same thing. A rendition marked `pending` names the V3 phase that makes it pass. A language
 * listed in `notApplicable` has a semantic reason in `docs/v3/language-parity.md`.
 *
 * Pending renditions are targets, not failing tests. Each phase removes its own `pending` marker.
 *
 * Open items for later phases:
 * - Event channels are `event:<scope>#<name>`, where the scope is the receiver's binding identity.
 *   Confirmed in Phase 12.1 for JS/TS and Python.
 * - Data direction: readers are expected as `consumes|reads` until Phase 11 decides a single
 *   vocabulary for reader edges across languages.
 */
export const PARITY_CORPUS: readonly CorpusScenario[] = [
  {
    name: 'imported function is called',
    family: 'imports and calls',
    renditions: {
      javascript: {
        files: {
          'util.ts': 'export function helper(): number {\n  return 1;\n}\n',
          'main.ts':
            "import { helper } from './util.js';\n\nexport function run(): number {\n  return helper();\n}\n",
        },
        expect: {
          relationships: ['imports main.ts -> util.ts', 'calls main.ts:run -> util.ts:helper'],
          symbols: ['main.ts:run', 'util.ts:helper'],
        },
      },
      python: {
        files: {
          'util.py': 'def helper():\n    return 1\n',
          'main.py': 'from util import helper\n\n\ndef run():\n    return helper()\n',
        },
        expect: {
          relationships: ['imports main.py -> util.py', 'calls main.py:run -> util.py:helper'],
          symbols: ['main.py:run', 'util.py:helper'],
        },
      },
      rust: {
        files: {
          'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n',
          'src/lib.rs': 'pub mod util;\npub mod run_mod;\n',
          'src/util.rs': 'pub fn helper() -> i32 {\n    1\n}\n',
          'src/run_mod.rs': 'use crate::util::helper;\n\npub fn run() -> i32 {\n    helper()\n}\n',
        },
        expect: {
          relationships: [
            'imports src/run_mod.rs -> src/util.rs',
            'calls src/run_mod.rs:run -> src/util.rs:helper',
          ],
          symbols: ['src/run_mod.rs:run', 'src/util.rs:helper'],
        },
      },
    },
  },

  {
    name: 'method called through a typed receiver',
    family: 'method calls',
    renditions: {
      javascript: {
        files: {
          'user.ts': 'export class User {\n  save(): void {}\n}\n',
          'main.ts':
            "import { User } from './user.js';\n\nexport function run(): void {\n  const user = new User();\n  user.save();\n}\n",
        },
        expect: {
          relationships: ['imports main.ts -> user.ts', 'calls main.ts:run -> user.ts:User.save'],
          symbols: ['user.ts:User.save'],
        },
        pending: '2.5',
      },
      python: {
        files: {
          'user.py': 'class User:\n    def save(self):\n        return None\n',
          'main.py':
            'from user import User\n\n\ndef run():\n    user: User = User()\n    user.save()\n',
        },
        expect: {
          relationships: ['calls main.py:run -> user.py:User.save'],
          symbols: ['user.py:User.save'],
        },
      },
      rust: {
        files: {
          'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n',
          'src/lib.rs':
            'pub struct User;\n\nimpl User {\n    pub fn save(&self) {}\n}\n\npub fn run() {\n    let user: User = User;\n    user.save();\n}\n',
        },
        expect: {
          relationships: ['calls src/lib.rs:run -> src/lib.rs:User.save'],
          symbols: ['src/lib.rs:User.save'],
        },
      },
    },
  },

  {
    name: 'same-named function in a sibling module is not connected (negative)',
    family: 'shadowing',
    renditions: {
      javascript: {
        files: {
          'a.ts': 'export function parse(): number {\n  return 1;\n}\n',
          'b.ts': 'export function parse(): number {\n  return 2;\n}\n',
          'main.ts':
            "import { parse } from './a.js';\n\nexport function run(): number {\n  return parse();\n}\n",
        },
        expect: {
          relationships: ['calls main.ts:run -> a.ts:parse'],
          absent: ['calls main.ts:run -> b.ts:parse'],
        },
      },
      python: {
        files: {
          'a.py': 'def parse():\n    return 1\n',
          'b.py': 'def parse():\n    return 2\n',
          'main.py': 'from a import parse\n\n\ndef run():\n    return parse()\n',
        },
        expect: {
          relationships: ['calls main.py:run -> a.py:parse'],
          absent: ['calls main.py:run -> b.py:parse'],
        },
      },
      rust: {
        files: {
          'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n',
          'src/lib.rs': 'pub mod a;\npub mod b;\n\npub fn run() -> i32 {\n    a::parse()\n}\n',
          'src/a.rs': 'pub fn parse() -> i32 {\n    1\n}\n',
          'src/b.rs': 'pub fn parse() -> i32 {\n    2\n}\n',
        },
        expect: {
          relationships: ['calls src/lib.rs:run -> src/a.rs:parse'],
          absent: ['calls src/lib.rs:run -> src/b.rs:parse'],
        },
      },
    },
  },

  {
    name: 'event published and subscribed on one emitter',
    family: 'events',
    renditions: {
      javascript: {
        files: {
          'main.ts':
            "export class Bus {\n  on(name: string, listener: () => void): void {}\n  emit(name: string): void {}\n}\n\nexport const bus = new Bus();\n\nexport function onReady(): void {}\n\nexport function start(): void {\n  bus.on('ready', onReady);\n}\n\nexport function publish(): void {\n  bus.emit('ready');\n}\n",
        },
        expect: {
          relationships: [
            'subscribes main.ts:onReady -> event:main.ts:bus#ready',
            'emits main.ts:publish -> event:main.ts:bus#ready',
          ],
        },
      },
      python: {
        files: {
          'main.py':
            "from pyee import EventEmitter\n\nbus = EventEmitter()\n\n\ndef on_ready():\n    return 1\n\n\ndef start():\n    bus.on('ready', on_ready)\n\n\ndef publish():\n    bus.emit('ready')\n",
        },
        expect: {
          relationships: [
            'subscribes main.py:on_ready -> event:main.py:bus#ready',
            'emits main.py:publish -> event:main.py:bus#ready',
          ],
        },
      },
    },
    notApplicable: {
      rust: 'Rust channels connect by passing values, not by name, so a name-keyed channel does not exist.',
    },
  },

  {
    name: 'same event name on two emitters does not connect',
    family: 'events',
    renditions: {
      javascript: {
        files: {
          'main.ts':
            "export class Bus {\n  on(name: string, listener: () => void): void {}\n  emit(name: string): void {}\n}\n\nexport const a = new Bus();\nexport const b = new Bus();\n\nexport function onReady(): void {}\n\nexport function start(): void {\n  b.on('ready', onReady);\n}\n\nexport function publish(): void {\n  a.emit('ready');\n}\n",
        },
        expect: {
          relationships: [
            'subscribes main.ts:onReady -> event:main.ts:b#ready',
            'emits main.ts:publish -> event:main.ts:a#ready',
          ],
          absent: [
            'emits main.ts:publish -> event:main.ts:b#ready',
            'subscribes main.ts:onReady -> event:main.ts:a#ready',
          ],
        },
      },
      python: {
        files: {
          'main.py':
            "from pyee import EventEmitter\n\na = EventEmitter()\nb = EventEmitter()\n\n\ndef on_ready():\n    return 1\n\n\ndef start():\n    b.on('ready', on_ready)\n\n\ndef publish():\n    a.emit('ready')\n",
        },
        expect: {
          relationships: [
            'subscribes main.py:on_ready -> event:main.py:b#ready',
            'emits main.py:publish -> event:main.py:a#ready',
          ],
          absent: [
            'emits main.py:publish -> event:main.py:b#ready',
            'subscribes main.py:on_ready -> event:main.py:a#ready',
          ],
        },
      },
    },
    notApplicable: {
      rust: 'Rust channels connect by passing values, not by name, so a name-keyed channel does not exist.',
    },
  },

  {
    name: 'value registered under a literal key and looked up',
    family: 'registries',
    renditions: {
      javascript: {
        files: {
          'main.ts':
            "export class User {}\n\nexport const registry = new Map<string, unknown>();\n\nexport function register(): void {\n  registry.set('user', User);\n}\n\nexport function load(): unknown {\n  return registry.get('user');\n}\n",
        },
        expect: {
          relationships: [
            'registers registry:main.ts:registry#user -> main.ts:User',
            'resolves main.ts:load -> registry:main.ts:registry#user',
          ],
        },
      },
      python: {
        files: {
          'main.py':
            "class User:\n    pass\n\n\nregistry = {}\nregistry['user'] = User\n\n\ndef load():\n    return registry['user']\n",
        },
        expect: {
          relationships: [
            'registers registry:main.py:registry#user -> main.py:User',
            'resolves main.py:load -> registry:main.py:registry#user',
          ],
        },
      },
      rust: {
        files: {
          'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n',
          'src/lib.rs':
            'use std::collections::HashMap;\n\npub struct User;\n\npub fn lookup() -> Option<&\'static User> {\n    let mut map: HashMap<&\'static str, User> = HashMap::new();\n    map.insert("user", User);\n    map.get("user")\n}\n',
        },
        expect: {
          relationships: [
            'registers registry:src/lib.rs:lookup.map#user -> src/lib.rs:User',
            'resolves src/lib.rs:lookup -> registry:src/lib.rs:lookup.map#user',
          ],
        },
      },
    },
  },

  {
    name: 'same key in two registries does not connect',
    family: 'registries',
    renditions: {
      javascript: {
        files: {
          'main.ts':
            "export class User {}\n\nexport const a = new Map<string, unknown>();\nexport const b = new Map<string, unknown>();\n\nexport function register(): void {\n  a.set('user', User);\n}\n\nexport function find(): unknown {\n  return b.get('user');\n}\n",
        },
        expect: {
          relationships: ['resolves main.ts:find -> registry:main.ts:b#user'],
          absent: ['resolves main.ts:find -> registry:main.ts:a#user'],
        },
      },
      python: {
        files: {
          'main.py':
            "class User:\n    pass\n\n\na = {}\nb = {}\na['user'] = User\n\n\ndef find():\n    return b['user']\n",
        },
        expect: {
          relationships: ['resolves main.py:find -> registry:main.py:b#user'],
          absent: ['resolves main.py:find -> registry:main.py:a#user'],
        },
      },
      rust: {
        files: {
          'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n',
          'src/lib.rs':
            'use std::collections::HashMap;\n\npub struct User;\n\npub fn find() -> Option<&\'static User> {\n    let mut a: HashMap<&\'static str, User> = HashMap::new();\n    a.insert("user", User);\n    let b: HashMap<&\'static str, User> = HashMap::new();\n    b.get("user")\n}\n',
        },
        expect: {
          relationships: ['resolves src/lib.rs:find -> registry:src/lib.rs:find.b#user'],
          absent: ['resolves src/lib.rs:find -> registry:src/lib.rs:find.a#user'],
        },
      },
    },
  },

  {
    name: 'module-level variable reassigned in a function is shared state',
    family: 'module-level state (D8)',
    renditions: {
      javascript: {
        files: {
          'store.ts': 'export let count = 0;\n\nexport function bump(): void {\n  count += 1;\n}\n',
        },
        expect: {
          relationships: ['writesState store.ts:bump -> state:store.ts:count'],
        },
      },
      python: {
        files: {
          'store.py': 'count = 0\n\n\ndef bump():\n    global count\n    count += 1\n',
        },
        expect: {
          relationships: ['writesState store.py:bump -> state:store.py:count'],
        },
      },
      rust: {
        files: {
          'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n',
          'src/lib.rs':
            'pub static mut COUNT: i32 = 0;\n\npub fn bump() {\n    unsafe {\n        COUNT += 1;\n    }\n}\n',
        },
        expect: {
          relationships: ['writesState src/lib.rs:bump -> state:src/lib.rs:COUNT'],
        },
        pending: '12.3',
      },
    },
  },

  {
    name: 'syntax error does not hide the rest of the file',
    family: 'syntax diagnostics',
    renditions: {
      javascript: {
        files: {
          'broken.ts': 'export function ok(): number {\n  return 1;\n}\n\nfunction broken( {\n',
        },
        expect: {
          symbols: ['broken.ts:ok'],
          syntaxErrors: ['broken.ts'],
        },
      },
      python: {
        files: {
          'broken.py': 'def ok():\n    return 1\n\n\ndef broken(:\n    return 1\n',
        },
        expect: {
          symbols: ['broken.py:ok'],
          syntaxErrors: ['broken.py'],
        },
      },
      rust: {
        files: {
          'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n',
          'src/lib.rs': 'pub fn ok() -> i32 {\n    1\n}\n\npub fn broken( -> i32 {\n',
        },
        expect: {
          symbols: ['src/lib.rs:ok'],
          syntaxErrors: ['src/lib.rs'],
        },
      },
    },
  },

  {
    name: 'data written by one file and read by another',
    family: 'data lineage',
    renditions: {
      javascript: {
        files: {
          'write.ts':
            "import { writeFileSync } from 'node:fs';\n\nexport function save(): void {\n  writeFileSync('data/out.json', '[]');\n}\n",
          'read.ts':
            "import { readFileSync } from 'node:fs';\n\nexport function load(): string {\n  return readFileSync('data/out.json', 'utf8');\n}\n",
        },
        expect: {
          relationships: [
            'generates write.ts -> data/out.json',
            'consumes|reads read.ts -> data/out.json',
          ],
        },
      },
      python: {
        files: {
          'write.py':
            "import json\n\n\ndef save():\n    with open('data/out.json', 'w') as f:\n        f.write('[]')\n",
          'read.py': "def load():\n    with open('data/out.json') as f:\n        return f.read()\n",
        },
        expect: {
          relationships: [
            'generates write.py -> data/out.json',
            'consumes|reads read.py -> data/out.json',
          ],
        },
      },
      rust: {
        files: {
          'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n',
          'src/lib.rs': 'pub mod write;\npub mod read;\n',
          'src/write.rs':
            'pub fn save() {\n    std::fs::write("data/out.json", "[]").unwrap();\n}\n',
          'src/read.rs':
            'pub fn load() -> String {\n    std::fs::read_to_string("data/out.json").unwrap()\n}\n',
        },
        expect: {
          relationships: [
            'generates src/write.rs -> data/out.json',
            'consumes|reads src/read.rs -> data/out.json',
          ],
        },
      },
    },
  },
  // 9.9 A. A local binding shadows an imported function inside its own function only.
  {
    name: 'a local binding shadows an imported function',
    family: 'shadowing',
    renditions: {
      javascript: {
        files: {
          'util.ts': 'export function helper(): number {\n  return 1;\n}\n',
          'main.ts':
            "import { helper } from './util.js';\n\nexport function run(): number {\n  const helper = (): number => 2;\n  return helper();\n}\n\nexport function direct(): number {\n  return helper();\n}\n",
        },
        expect: {
          relationships: ['calls main.ts:direct -> util.ts:helper'],
          absent: ['calls main.ts:run -> util.ts:helper'],
        },
      },
      python: {
        files: {
          'util.py': 'def helper():\n    return 1\n',
          'main.py':
            'from util import helper\n\n\ndef run():\n    helper = lambda: 2\n    return helper()\n\n\ndef direct():\n    return helper()\n',
        },
        expect: {
          relationships: ['calls main.py:direct -> util.py:helper'],
          absent: ['calls main.py:run -> util.py:helper'],
        },
      },
      rust: {
        files: {
          'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n',
          'src/lib.rs': 'pub mod util;\npub mod user;\n',
          'src/util.rs': 'pub fn helper() -> i32 {\n    1\n}\n',
          'src/user.rs':
            'use crate::util::helper;\n\npub fn run() -> i32 {\n    let helper = || 2;\n    helper()\n}\n\npub fn direct() -> i32 {\n    helper()\n}\n',
        },
        expect: {
          relationships: [
            'imports src/user.rs -> src/util.rs',
            'calls src/user.rs:direct -> src/util.rs:helper',
          ],
          absent: ['calls src/user.rs:run -> src/util.rs:helper'],
        },
      },
    },
  },

  // 9.9 B. A method on a receiver of unknown type is not connected to any type (negative).
  {
    name: 'a method on a receiver of unknown type is not connected (negative)',
    family: 'method calls',
    renditions: {
      javascript: {
        files: {
          'user.ts':
            'export class User {\n  save(): void {}\n}\n\nexport class Other {\n  save(): void {}\n}\n',
          'main.ts': 'export function run(thing: any): void {\n  thing.save();\n}\n',
        },
        expect: {
          absent: [
            'calls main.ts:run -> user.ts:User.save',
            'calls main.ts:run -> user.ts:Other.save',
          ],
        },
      },
      python: {
        files: {
          'user.py': 'class User:\n    def save(self):\n        return None\n',
          'other.py': 'class Other:\n    def save(self):\n        return None\n',
          'main.py': 'def run(thing):\n    thing.save()\n',
        },
        expect: {
          absent: [
            'calls main.py:run -> user.py:User.save',
            'calls main.py:run -> other.py:Other.save',
          ],
        },
      },
      rust: {
        files: {
          'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n',
          'src/lib.rs':
            'pub struct User;\n\nimpl User {\n    pub fn save(&self) {}\n}\n\npub struct Other;\n\nimpl Other {\n    pub fn save(&self) {}\n}\n\npub fn run<T>(thing: T) {\n    thing.save();\n}\n',
        },
        expect: {
          absent: [
            'calls src/lib.rs:run -> src/lib.rs:User.save',
            'calls src/lib.rs:run -> src/lib.rs:Other.save',
          ],
        },
      },
    },
  },

  // 9.9 C. A method called on the result of a constructor is connected to the type's method.
  {
    name: 'a method called on a constructor result is connected',
    family: 'method calls',
    renditions: {
      javascript: {
        files: {
          'user.ts': 'export class User {\n  save(): void {}\n}\n',
          'main.ts':
            "import { User } from './user.js';\n\nexport function run(): void {\n  const user = new User();\n  user.save();\n}\n",
        },
        expect: {
          relationships: ['calls main.ts:run -> user.ts:User.save'],
          symbols: ['user.ts:User.save'],
        },
        pending: '2.5',
      },
      python: {
        files: {
          'user.py': 'class User:\n    def save(self):\n        return None\n',
          'main.py': 'from user import User\n\n\ndef run():\n    user = User()\n    user.save()\n',
        },
        expect: {
          relationships: ['calls main.py:run -> user.py:User.save'],
          symbols: ['user.py:User.save'],
        },
      },
      rust: {
        files: {
          'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n',
          'src/lib.rs':
            'pub struct User;\n\nimpl User {\n    pub fn new() -> Self {\n        User\n    }\n\n    pub fn save(&self) {}\n}\n\npub fn run() {\n    let user = User::new();\n    user.save();\n}\n',
        },
        expect: {
          relationships: ['calls src/lib.rs:run -> src/lib.rs:User.save'],
          symbols: ['src/lib.rs:User.save'],
        },
      },
    },
  },

  // 9.9 D. Two glob imports that supply one name leave the name unconnected (negative).
  {
    name: 'two globs that supply one name leave it unconnected (negative)',
    family: 'shadowing',
    renditions: {
      javascript: {
        files: {
          'a.ts': 'export function make(): number {\n  return 1;\n}\n',
          'b.ts': 'export function make(): number {\n  return 2;\n}\n',
          'index.ts': "export * from './a.js';\nexport * from './b.js';\n",
          'main.ts':
            "import { make } from './index.js';\n\nexport function run(): number {\n  return make();\n}\n",
        },
        expect: {
          absent: [
            'calls main.ts:run -> a.ts:make',
            'calls main.ts:run -> b.ts:make',
            'calls main.ts:run -> index.ts:make',
          ],
        },
      },
      python: {
        files: {
          'a.py': 'def make():\n    return 1\n',
          'b.py': 'def make():\n    return 2\n',
          'main.py': 'from a import *\nfrom b import *\n\n\ndef run():\n    return make()\n',
        },
        expect: {
          absent: ['calls main.py:run -> a.py:make', 'calls main.py:run -> b.py:make'],
        },
      },
      rust: {
        files: {
          'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n',
          'src/lib.rs':
            'pub mod a;\npub mod b;\n\nuse a::*;\nuse b::*;\n\npub fn run() -> i32 {\n    make()\n}\n',
          'src/a.rs': 'pub fn make() -> i32 {\n    1\n}\n',
          'src/b.rs': 'pub fn make() -> i32 {\n    2\n}\n',
        },
        expect: {
          absent: [
            'calls src/lib.rs:run -> src/a.rs:make',
            'calls src/lib.rs:run -> src/b.rs:make',
          ],
        },
      },
    },
  },

  // 9.9 E. A name re-exported through three modules still connects to its definition.
  {
    name: 'a name re-exported through three modules connects to its definition',
    family: 'imports and calls',
    renditions: {
      javascript: {
        files: {
          'c.ts': 'export function helper(): number {\n  return 1;\n}\n',
          'b.ts': "export { helper } from './c.js';\n",
          'a.ts': "export { helper } from './b.js';\n",
          'main.ts':
            "import { helper } from './a.js';\n\nexport function run(): number {\n  return helper();\n}\n",
        },
        expect: {
          relationships: ['calls main.ts:run -> c.ts:helper'],
          symbols: ['c.ts:helper'],
        },
      },
      python: {
        files: {
          'c.py': 'def helper():\n    return 1\n',
          'b.py': 'from c import helper as helper\n',
          'a.py': 'from b import helper as helper\n',
          'main.py': 'from a import helper\n\n\ndef run():\n    return helper()\n',
        },
        expect: {
          relationships: ['calls main.py:run -> c.py:helper'],
          symbols: ['c.py:helper'],
        },
      },
      rust: {
        files: {
          'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n',
          'src/lib.rs':
            'pub mod a;\npub mod b;\npub mod c;\n\npub fn run() -> i32 {\n    a::helper()\n}\n',
          'src/a.rs': 'pub use crate::b::helper;\n',
          'src/b.rs': 'pub use crate::c::helper;\n',
          'src/c.rs': 'pub fn helper() -> i32 {\n    1\n}\n',
        },
        expect: {
          relationships: ['calls src/lib.rs:run -> src/c.rs:helper'],
          symbols: ['src/c.rs:helper'],
        },
      },
    },
  },

  // 9.9 F. A type that implements a trait is linked to the trait.
  {
    name: 'a type that implements a trait is linked to it',
    family: 'inheritance',
    renditions: {
      javascript: {
        files: {
          'shape.ts': 'export interface Shape {\n  area(): number;\n}\n',
          'square.ts':
            "import type { Shape } from './shape.js';\n\nexport class Square implements Shape {\n  area(): number {\n    return 1;\n  }\n}\n",
        },
        expect: {
          relationships: ['implements square.ts:Square -> shape.ts:Shape'],
        },
      },
      python: {
        files: {
          'iface.py': 'import abc\n\n\nclass Shape(abc.ABC):\n    pass\n',
          'impl.py':
            'from iface import Shape\n\n\nclass Square:\n    pass\n\n\nShape.register(Square)\n',
        },
        expect: {
          relationships: ['implements impl.py:Square -> iface.py:Shape'],
        },
      },
      rust: {
        files: {
          'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n',
          'src/lib.rs':
            'pub trait Shape {\n    fn area(&self) -> f64;\n}\n\npub struct Square;\n\nimpl Shape for Square {\n    fn area(&self) -> f64 {\n        1.0\n    }\n}\n',
        },
        expect: {
          relationships: ['implements src/lib.rs:Square -> src/lib.rs:Shape'],
          symbols: ['src/lib.rs:Square[Shape].area'],
        },
      },
    },
  },
  // A base-class method called through super is connected to the base method.
  {
    name: 'a base-class method called through super is connected',
    family: 'inheritance',
    renditions: {
      javascript: {
        files: {
          'base.ts': 'export class Base {\n  save(): void {}\n}\n',
          'child.ts':
            "import { Base } from './base.js';\n\nexport class Child extends Base {\n  save(): void {\n    super.save();\n  }\n}\n",
        },
        expect: {
          relationships: [
            'extends child.ts:Child -> base.ts:Base',
            'calls child.ts:Child.save -> base.ts:Base.save',
          ],
        },
        pending: '2.5',
      },
      python: {
        files: {
          'base.py': 'class Base:\n    def save(self):\n        return None\n',
          'child.py':
            'from base import Base\n\n\nclass Child(Base):\n    def save(self):\n        return super().save()\n',
        },
        expect: {
          relationships: [
            'extends child.py:Child -> base.py:Base',
            'calls child.py:Child.save -> base.py:Base.save',
          ],
        },
      },
    },
    notApplicable: {
      rust: 'Rust has no class inheritance and no super method call. Trait default methods are covered by 9.6.',
    },
  },
  {
    name: 'configured decorator or attribute registers a route that a bare call reaches',
    family: 'registries',
    renditions: {
      javascript: {
        files: {
          'app.ts':
            "function route(path: string): MethodDecorator {\n  return () => undefined;\n}\n\nexport class Users {\n  @route('/users')\n  list(): number[] {\n    return [];\n  }\n}\n\nexport function navigate(path: string): void {}\n\nexport function go(): void {\n  navigate('/users');\n}\n\nexport function other(page: { navigate(path: string): void }): void {\n  page.navigate('/users');\n}\n",
        },
        config: {
          protocols: {
            registries: {
              decorators: [{ name: 'route', registry: 'routes', keyArg: 0 }],
              methods: [{ method: 'navigate', direction: 'route', keyArg: 0, registry: 'routes' }],
            },
          },
        },
        expect: {
          relationships: [
            'registers registry:routes#/users -> app.ts:Users.list',
            'routesTo app.ts:go -> registry:routes#/users',
          ],
          absent: ['routesTo app.ts:other -> registry:routes#/users'],
        },
      },
      python: {
        files: {
          'm.py':
            "from flask import Flask\n\napp = Flask(__name__)\n\n\n@app.route('/users')\ndef users():\n    return []\n\n\ndef go():\n    return navigate('/users')\n\n\ndef other(page):\n    return page.navigate('/users')\n",
        },
        config: {
          protocols: {
            registries: {
              attributes: [{ name: 'app.route', key: { arg: 0 }, registry: 'routes' }],
              methods: [{ method: 'navigate', direction: 'route', keyArg: 0, registry: 'routes' }],
            },
          },
        },
        expect: {
          relationships: [
            'registers registry:routes#/users -> m.py:users',
            'routesTo m.py:go -> registry:routes#/users',
          ],
          absent: ['routesTo m.py:other -> registry:routes#/users'],
        },
      },
      rust: {
        files: {
          'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
          'src/lib.rs':
            '#[route("/users")]\npub fn users() -> Vec<u8> {\n    Vec::new()\n}\n\npub fn go() -> Vec<u8> {\n    navigate("/users")\n}\n\npub fn other(page: Page) -> Vec<u8> {\n    page.navigate("/users")\n}\n',
        },
        config: {
          protocols: {
            registries: {
              attributes: [{ name: 'route', key: { arg: 0 }, registry: 'routes' }],
              methods: [{ method: 'navigate', direction: 'route', keyArg: 0, registry: 'routes' }],
            },
          },
        },
        expect: {
          relationships: [
            'registers registry:routes#/users -> src/lib.rs:users',
            'routesTo src/lib.rs:go -> registry:routes#/users',
          ],
          absent: ['routesTo src/lib.rs:other -> registry:routes#/users'],
        },
      },
    },
  },
];

assertUniqueNames(PARITY_CORPUS);
