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
          relationships: ['calls src/lib.rs -> src/lib.rs:make!'],
          absent: ['calls src/lib.rs:run -> src/lib.rs:generated'],
        },
      },
    },
  },

  {
    name: 'derive from a proc-macro dependency references the derive function',
    family: 'macros',
    renditions: {
      rust: {
        files: {
          'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
          'crates/derive/Cargo.toml':
            '[package]\nname = "my-derive"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\nproc-macro = true\n',
          'crates/derive/src/lib.rs':
            '#[proc_macro_derive(Describe)]\npub fn describe(input: TokenStream) -> TokenStream {\n    input\n}\n',
          'crates/app/Cargo.toml':
            '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nmy-derive = { path = "../derive" }\n',
          'crates/app/src/lib.rs': '#[derive(Describe)]\npub struct Point;\n',
        },
        expect: {
          relationships: [
            'references crates/app/src/lib.rs:Point -> crates/derive/src/lib.rs:describe',
          ],
        },
      },
    },
  },

  {
    name: 'attribute from a proc-macro dependency references the attribute function',
    family: 'macros',
    renditions: {
      rust: {
        files: {
          'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
          'crates/derive/Cargo.toml':
            '[package]\nname = "my-derive"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\nproc-macro = true\n',
          'crates/derive/src/lib.rs':
            '#[proc_macro_attribute]\npub fn route(attr: TokenStream, item: TokenStream) -> TokenStream {\n    item\n}\n',
          'crates/app/Cargo.toml':
            '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nmy-derive = { path = "../derive" }\n',
          'crates/app/src/lib.rs': '#[route(get)]\npub fn handler() {}\n',
        },
        expect: {
          relationships: [
            'references crates/app/src/lib.rs:handler -> crates/derive/src/lib.rs:route',
          ],
        },
      },
    },
  },

  {
    name: 'derive without a proc-macro dependency is not linked (negative)',
    family: 'macros',
    renditions: {
      rust: {
        files: {
          'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
          'crates/derive/Cargo.toml':
            '[package]\nname = "my-derive"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\nproc-macro = true\n',
          'crates/derive/src/lib.rs':
            '#[proc_macro_derive(Describe)]\npub fn describe(input: TokenStream) -> TokenStream {\n    input\n}\n',
          'crates/app/Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
          'crates/app/src/lib.rs': '#[derive(Describe)]\npub struct Point;\n',
        },
        expect: {
          absent: ['references crates/app/src/lib.rs:Point -> crates/derive/src/lib.rs:describe'],
        },
      },
    },
  },

  {
    name: 'include_str of a data file consumes it from the function that holds the macro',
    family: 'macros',
    renditions: {
      rust: {
        files: {
          'Cargo.toml': CARGO,
          'src/lib.rs':
            'pub fn load() -> &\'static str {\n    include_str!("data/config.json")\n}\n',
          'src/data/config.json': '{}\n',
        },
        expect: {
          relationships: ['consumes src/lib.rs:load -> src/data/config.json'],
        },
      },
    },
  },

  {
    name: 'include! imports the included file from the including file',
    family: 'macros',
    renditions: {
      rust: {
        files: {
          'Cargo.toml': CARGO,
          'src/lib.rs': 'include!("gen.rs");\n\npub fn run() -> i32 {\n    generated()\n}\n',
          'src/gen.rs': 'pub fn generated() -> i32 {\n    1\n}\n',
        },
        expect: {
          relationships: ['imports src/lib.rs -> src/gen.rs'],
        },
      },
    },
  },

  {
    name: 'include_str with a variable path draws no consumes edge (negative)',
    family: 'macros',
    renditions: {
      rust: {
        files: {
          'Cargo.toml': CARGO,
          'src/lib.rs': "pub fn load(path: &str) -> &'static str {\n    include_str!(path)\n}\n",
          'src/data/config.json': '{}\n',
        },
        expect: {
          absent: ['consumes src/lib.rs:load -> src/data/config.json'],
        },
      },
    },
  },

  {
    name: 'build script rerun-if-changed reads the file it names',
    family: 'macros',
    renditions: {
      rust: {
        files: {
          'Cargo.toml': CARGO,
          'build.rs': 'fn main() {\n    println!("cargo:rerun-if-changed=data/schema.json");\n}\n',
          'src/lib.rs': 'pub fn run() {}\n',
          'data/schema.json': '{}\n',
        },
        expect: {
          relationships: ['reads build.rs:main -> data/schema.json'],
        },
      },
    },
  },

  {
    name: 'include of OUT_DIR depends on the build script of its package',
    family: 'macros',
    renditions: {
      rust: {
        files: {
          'Cargo.toml': CARGO,
          'build.rs': 'fn main() {}\n',
          'src/lib.rs': 'include!(concat!(env!("OUT_DIR"), "/generated.rs"));\n',
        },
        expect: {
          relationships: [
            'dependsOn package:cargo:.#lib:demo -> package:cargo:.#build-script:build',
          ],
        },
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
  // A call through a dyn trait object reaches the trait's method.
  {
    name: 'a call through a dyn trait object reaches the trait method',
    family: 'traits',
    renditions: {
      rust: {
        files: {
          'Cargo.toml': CARGO,
          'src/lib.rs':
            'pub trait Render {\n    fn render(&self) -> i32;\n}\n\npub struct A;\n\nimpl Render for A {\n    fn render(&self) -> i32 {\n        1\n    }\n}\n\npub fn show(item: &dyn Render) -> i32 {\n    item.render()\n}\n',
        },
        expect: {
          relationships: ['calls src/lib.rs:show -> src/lib.rs:Render.render'],
        },
      },
    },
  },
  // A call through a generic receiver with one trait bound reaches the trait's method.
  {
    name: 'a call through a generic receiver with one trait bound reaches the trait method',
    family: 'traits',
    renditions: {
      rust: {
        files: {
          'Cargo.toml': CARGO,
          'src/lib.rs':
            'pub trait Render {\n    fn render(&self) -> i32;\n}\n\npub fn show<T: Render>(item: &T) -> i32 {\n    item.render()\n}\n',
        },
        expect: {
          relationships: ['calls src/lib.rs:show -> src/lib.rs:Render.render'],
        },
      },
    },
  },
];

assertUniqueNames(RUST_CORPUS);
