import { assertUniqueNames, type CorpusScenario } from './corpus-types.js';

/**
 * Rust-only forms and negatives. Each scenario is pending until its phase lands, so the
 * expectations are targets. Macro expansion is out of scope for V3, so expectations about macro
 * output assert that no item is invented, not that one is found.
 */
const CARGO = '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n';

export const RUST_CORPUS: readonly CorpusScenario[] = [
  {
    name: 'cfg twin modules are both declared',
    family: 'modules',
    renditions: {
      rust: {
        files: {
          'Cargo.toml': CARGO,
          'src/lib.rs':
            '#[cfg(unix)]\nmod imp;\n\n#[cfg(windows)]\n#[path = "win.rs"]\nmod imp_win;\n',
          'src/imp.rs': 'pub fn open() {}\n',
          'src/win.rs': 'pub fn open() {}\n',
        },
        expect: {
          relationships: [
            'declaresModule src/lib.rs -> src/imp.rs',
            'declaresModule src/lib.rs -> src/win.rs',
          ],
        },
      },
    },
  },

  {
    name: 'macro-generated item is not invented (negative)',
    family: 'macros',
    renditions: {
      rust: {
        files: {
          'Cargo.toml': CARGO,
          'src/lib.rs':
            'macro_rules! make {\n    () => {\n        pub fn generated() -> i32 {\n            1\n        }\n    };\n}\n\nmake!();\n\npub fn run() -> i32 {\n    generated()\n}\n',
        },
        expect: {
          symbols: ['src/lib.rs:run'],
          absent: ['calls src/lib.rs:run -> src/lib.rs:generated'],
        },
        pending: '10.1',
      },
    },
  },

  {
    name: 'mod inside a raw string is not a declaration (negative)',
    family: 'lexing',
    renditions: {
      rust: {
        files: {
          'Cargo.toml': CARGO,
          'src/lib.rs': 'pub const TEXT: &str = r#"mod hidden;"#;\n',
          'src/hidden.rs': 'pub fn hidden() {}\n',
        },
        expect: {
          noSyntaxErrors: true,
          absent: ['declaresModule src/lib.rs -> src/hidden.rs'],
        },
      },
    },
  },

  {
    name: 'mod inside a nested block comment is not a declaration (negative)',
    family: 'lexing',
    renditions: {
      rust: {
        files: {
          'Cargo.toml': CARGO,
          'src/lib.rs': '/* outer /* inner */ mod ghost; */\npub fn run() -> i32 {\n    1\n}\n',
          'src/ghost.rs': 'pub fn ghost() {}\n',
        },
        expect: {
          symbols: ['src/lib.rs:run'],
          absent: ['declaresModule src/lib.rs -> src/ghost.rs'],
        },
      },
    },
  },

  {
    name: 'lifetimes and char literals are not confused',
    family: 'lexing',
    renditions: {
      rust: {
        files: {
          'Cargo.toml': CARGO,
          'src/lib.rs':
            "pub fn first<'a>(s: &'a str) -> char {\n    let _quote = '\\'';\n    s.chars().next().unwrap_or('a')\n}\n",
        },
        expect: {
          symbols: ['src/lib.rs:first'],
          noSyntaxErrors: true,
        },
      },
    },
  },

  {
    name: 'raw identifiers are names, not keywords',
    family: 'lexing',
    renditions: {
      rust: {
        files: {
          'Cargo.toml': CARGO,
          'src/lib.rs':
            'pub struct Item {\n    pub r#type: String,\n}\n\npub fn kind(i: &Item) -> &str {\n    &i.r#type\n}\n',
        },
        expect: {
          symbols: ['src/lib.rs:Item', 'src/lib.rs:kind'],
          noSyntaxErrors: true,
        },
      },
    },
  },

  {
    name: 'file no crate reaches is reported (negative)',
    family: 'modules',
    renditions: {
      rust: {
        files: {
          'Cargo.toml': CARGO,
          'src/lib.rs': 'pub fn run() -> i32 {\n    1\n}\n',
          'src/orphan.rs': 'pub fn lost() {}\n',
        },
        expect: {
          diagnostics: ['unreachable-module src/orphan.rs'],
        },
      },
    },
  },

  {
    name: 'foo.rs and foo/mod.rs together are a conflict, and neither is chosen',
    family: 'modules',
    renditions: {
      rust: {
        files: {
          'Cargo.toml': CARGO,
          'src/lib.rs': 'mod foo;\n',
          'src/foo.rs': 'pub fn a() {}\n',
          'src/foo/mod.rs': 'pub fn b() {}\n',
        },
        expect: {
          diagnostics: ['module-conflict src/lib.rs'],
        },
      },
    },
  },

  {
    name: 'Display and Debug both define fmt on one type',
    family: 'traits',
    renditions: {
      rust: {
        files: {
          'Cargo.toml': CARGO,
          'src/lib.rs':
            'use std::fmt;\n\npub struct Point;\n\nimpl fmt::Display for Point {\n    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {\n        Ok(())\n    }\n}\n\nimpl fmt::Debug for Point {\n    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {\n        Ok(())\n    }\n}\n',
        },
        expect: {
          symbols: ['src/lib.rs:Point[Display].fmt', 'src/lib.rs:Point[Debug].fmt'],
        },
      },
    },
  },
];

assertUniqueNames(RUST_CORPUS);
