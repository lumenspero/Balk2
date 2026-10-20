import { assertUniqueNames, type CorpusScenario } from './corpus-types.js';

/**
 * Language-neutral parity scenarios. Each scenario has one rendition per language, written to mean
 * the same thing. A rendition marked `pending` names the V3 phase that makes it pass. A language
 * listed in `notApplicable` has a semantic reason in `docs/v3/language-parity.md`.
 *
 * Pending renditions are targets, not failing tests. Each phase removes its own `pending` marker.
 *
 * Open items for later phases:
 * - Event channels: exact expectations need the verified `event:<scope>#<name>` scope rules. Add
 *   the events scenario in Phase 12.1 once those rules are confirmed.
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
        pending: '9',
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
        pending: '5',
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
        pending: '9.6',
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
        pending: '9.6',
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
        pending: '12.3',
      },
      python: {
        files: {
          'store.py': 'count = 0\n\n\ndef bump():\n    global count\n    count += 1\n',
        },
        expect: {
          relationships: ['writesState store.py:bump -> state:store.py:count'],
        },
        pending: '12.3',
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
        pending: '3.3',
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
        pending: '6.2',
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
        pending: '11.3',
      },
    },
  },
];

assertUniqueNames(PARITY_CORPUS);
