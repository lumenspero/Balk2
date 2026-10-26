# Rust

This page lists what Balk2 recognizes in Rust (`.rs` files and the crates of a `Cargo.toml`), how it
resolves each form, and where the analysis stops. The Rust cells in `language-parity.md` link here.

## Recognized forms

### Imports, items and calls

- `use` declarations and `mod` declarations, with the module tree built from `lib.rs`, `main.rs` and
  the files they declare.
- Exports are read for the crate's library target only. Items in a binary target are not exports.
- Calls to resolved functions and constructions. Method calls are linked when the receiver's type is
  known from an annotated binding or from a constructor result (see Limits).
- Inheritance and trait implementation (`impl`, `trait:`), type references, and derives and attributes
  (row 10).
- `cfg` conditions are recorded as metadata (row 26).
- `Command::new` is matched by name, and the process is recorded as an `executes` edge.
- `libloading` loads are recorded as observations (see Native libraries).

### Registries

Rust registries are read in four forms. Each is configured or read from source; none is inferred from
a framework by default.

#### Local maps

A map held in a local `let` is a registry when its type is annotated as `HashMap` or `BTreeMap`, or
it is built with `HashMap::new()`, `HashMap::with_capacity(..)` or the `BTreeMap` equivalents:

```rust
fn build() -> Option<&'static str> {
    let mut map: HashMap<&str, Handler> = HashMap::new();
    map.insert("user", handler);
    map.entry("admin").or_insert(other);
    map.get("user").copied()
}
```

`insert` and `entry(k).or_insert(v)` register `v` under `k`. `get` and `contains_key` look `k` up. Only
a literal string or integer key is static; any other key is dynamic. Only a single `let`, bound
once, is read. Not read: maps in struct fields, `self.map`, and maps passed in as parameters.

#### Static maps

A `static` whose initializer builds exactly one local map registers into the static itself. This is the
form used with `LazyLock`, `OnceLock` and `Lazy`:

```rust
pub static REGISTRY: LazyLock<HashMap<&str, Handler>> = LazyLock::new(|| {
    let mut m = HashMap::new();
    m.insert("user", Handler);
    m
});
```

The inserts register under the static, so the registry is `REGISTRY`, not the local `m`. A static that
builds two maps is not read, because the registry it names is ambiguous.

#### Literal tables and `lazy_static!`

A `phf_map!` or `phf_ordered_map!` table in a `static` declares each literal key under the static:

```rust
pub static REGISTRY: phf::Map<&str, Handler> = phf_map! {
    "user" => User,
};
```

A `lazy_static!` block reads each `static ref NAME: T = <initializer>` as a static, so the map rules
above apply to it:

```rust
lazy_static! {
    static ref REGISTRY: HashMap<&str, User> = {
        let mut m = HashMap::new();
        m.insert("user", User);
        m
    };
}
```

A `get` or `contains_key` on a static registry of the same file looks it up. A static used from
another file is not matched yet.

#### Attributes and configured recipes

An attribute on a free function or type declares the item under a key. The attribute name is matched as
written in the file. The recipes below use the attribute and method configuration.

##### Tauri commands (recipe)

A Tauri command is a Rust function the frontend calls by name with `invoke`. Configure both sides:

```json
{
  "protocols": {
    "registries": {
      "attributes": [{ "name": "tauri::command", "key": "fn-name", "registry": "commands" }],
      "methods": [
        { "method": "invoke", "direction": "resolve", "keyArg": 0, "registry": "commands" }
      ]
    }
  }
}
```

```rust
#[tauri::command]
pub fn greet() -> String { String::new() }
```

```ts
invoke('greet'); // resolves to the greet command in the commands registry
```

Both sides meet at one key node, `registry:commands#greet`. The attribute `name` is matched as
written: if the file imports `command` with `use tauri::command;`, configure `"name": "command"` as well.

Limits:

- `invoke` is matched only as a bare call. `api.invoke('greet')` is not matched. A local function named
  `invoke` also matches, because the import is not checked.
- Attributes on methods in an `impl` or `trait` are not read.
- Rust code that calls a command is not read; the Tauri lookup is on the TypeScript side.

##### Configured bare calls (recipe)

A method the configuration names with a registry is read in function bodies when it is called bare,
such as `navigate("/users")`. Calls on a receiver, such as `page.navigate("/users")`, are not matched:

```json
{
  "protocols": {
    "registries": {
      "methods": [{ "method": "navigate", "direction": "route", "keyArg": 0, "registry": "routes" }]
    }
  }
}
```

A call whose path has more than one segment, such as `module::navigate(..)`, is not matched either.

### Shared state

- A write to a `static mut` inside a function is shared state, at the static's path, including inside
  `unsafe`. A compound assignment reads and writes.
- Method calls on an interior-mutable static are read by the method's effect:
  - atomics (`Atomic*`): `load` reads; `store` writes; `swap`, `fetch_*` and `compare_exchange*` read
    and write;
  - `Mutex` and `RwLock`: `lock`, `read`, `write` and their `try_` forms are reads;
  - `OnceLock` and `OnceCell`: `get` reads; `set`, `take` and `initialize` write; `get_or_init` reads
    and writes;
  - `LazyLock`, `LazyCell` and `Lazy`: `force` reads. A wrapped `LazyLock<Mutex<..>>` is also read as a
    `Mutex`.
- A `lazy_static!` static is read by its declared type, the same as a plain static.
- A `thread_local!` static is read through `LocalKey` methods: `with`, `with_borrow` and `get` read;
  `with_borrow_mut`, `set`, `take` and `replace` write.
- A configured singleton is read through its fields. With a `static` named `STORE` in `src/lib.rs`,
  `STORE.count += 1` in a function reads and writes field `count`, and `STORE.a.b = 1` writes `a.b`:

```json
{ "state": { "singletons": [{ "module": "src/lib.rs", "export": "STORE" }] } }
```

The limits of shared-state recording are listed in `docs/v3/language-parity.md`.

### Callbacks

- `thread::spawn(f)` and `std::thread::spawn(f)` are read when no repository symbol has that path.
- `map`, `filter`, `for_each`, `filter_map` and `flat_map` are read by method name, whatever the
  receiver is. The receiver's type is not checked.
- A closure is inline. A path that names a repository function links to it. Any other argument is an
  unresolved observation at low confidence.

### Native libraries

`libloading::Library::new(path)` loads a shared library at run time, and the library's code is not
analyzed. A string-literal path is recorded as an `unresolved-module-path` observation, and any other
path as a `dynamic-module-specifier` observation, both from the function that makes the load. Only the
full path is read. A `Library::new` reached through `use libloading::Library` is not read yet.

### Binding crates

Three binding kinds connect a Rust crate to code in another language. Each is read from the crate that
declares the exports, and the edge's `metadata.mechanism` names the kind.

| Kind           | Rust side                                                          | Other side                       | Default module or package                                 |
| -------------- | ------------------------------------------------------------------ | -------------------------------- | --------------------------------------------------------- |
| `wasm-bindgen` | `#[wasm_bindgen]` items, and `extern` blocks with `module = "..."` | JS/TS imports of the wasm output | `pkg/<lib>.js`                                            |
| `napi`         | `#[napi]` functions, classes and `js_name`                         | JS/TS imports of the npm package | the `name` in the crate's `package.json`                  |
| `pyo3`         | `#[pyfunction]`, `#[pyclass]`, `#[pymodule]`                       | Python imports of the module     | `[tool.maturin] module-name`, else the `#[pymodule]` name |

A crate is read as a binding only when its `Cargo.toml` depends on the library (`wasm-bindgen`, `napi`
or `napi-derive`, `pyo3`).

The defaults can be overridden per crate under `rust.bindings`. Each entry names a crate and one
override its kind accepts, and an entry for a crate that is not in the repository, or does not depend
on the library, is reported and ignored:

```json
{
  "version": 3,
  "rust": {
    "bindings": [
      { "kind": "wasm-bindgen", "crate": "core", "outDir": "web/pkg" },
      { "kind": "napi", "crate": "native", "packageName": "@scope/native" },
      { "kind": "pyo3", "crate": "fastpath", "pythonModule": "app.native" }
    ]
  }
}
```

- `outDir` (`wasm-bindgen`) is the repository-relative directory of the wasm output. It must not be
  absolute, contain a backslash, or contain `..`.
- `packageName` (`napi`) is the npm package name the JS side imports.
- `pythonModule` (`pyo3`) is the dotted Python module name. It belongs inside the `pyo3` entry, not at
  the top level, and it takes precedence over `[tool.maturin] module-name`.

Confidence follows the source of the name:

- `wasm-bindgen`: `high` when `outDir` is configured, `medium` for the default `pkg/` path.
- `napi`: `high` when `packageName` is configured, `medium` when the `package.json` name is used.
- `pyo3`: `high` when `pythonModule`, `[tool.maturin] module-name`, or a `#[pymodule]` name argument
  sets the module; `medium` when the module name is inferred from the Rust item.

Each binding kind produces `calls` edges from the consuming code to the exported Rust item. The
wasm-bindgen extern blocks also produce an `imports` edge from the Rust file to the JS module, with
`loadKind: wasm-bindgen-module`.

### Macro-generated names

The analyzer does not expand macros. A path to a name that a module does not declare is reported as
`unresolved-module-path` when the module has no item-level macro call. When it does, the path is
reported as `macro-generated-item` with the call named in its detail, since the call may generate the
name. Macro templates are not code: the tokens of a macro argument that is not an expression (such as a
`quote!` body or a `macro_rules!` definition) declare and name nothing. Macros listed under
`rust.macros.expressionLike` are read as code, so calls inside their arguments are linked.

### Source annotations

A `// balk2:` line comment directly above a statement can set confidence, and must name the innermost
function that holds the statement, or the file at top level. Doc comments (`///`, `//!`) and text inside
a string are not directives.

## Resolution rules

- A registry key is scoped by its registry. A static registry is named by the static's path; a local
  map is named by its binding and is read only within its function.
- Recipe attribute names and method names are matched as written. Recipes match bare calls and single
  path segments only.
- A receiver's type comes from an annotated binding or a constructor result. Other receivers are not
  typed.
- Binding crate names match `-` and `_` alike, as Cargo does.
- Binding overrides apply to the crate they name and to no other.

## Mechanisms

| Mechanism                | Edge types or records                                                           | Notes                                              |
| ------------------------ | ------------------------------------------------------------------------------- | -------------------------------------------------- |
| Module imports and calls | `imports`, `calls`                                                              | module tree from the crate root                    |
| Registries               | `registers`, `resolves`, `routesTo`                                             | literal keys; `registry:<name>#<key>` nodes        |
| Shared state             | shared-state relationships to a state path                                      | `static mut`, interior-mutable statics, singletons |
| Callbacks                | `passesCallback`                                                                | repository functions and closures                  |
| Native libraries         | `unresolved-module-path` or `dynamic-module-specifier` observations             | observation only                                   |
| Binding crates           | `calls` with `wasm-bindgen`, `napi` or `pyo3`; `imports` for wasm extern blocks | confidence per the rules above                     |
| Process execution        | `executes`                                                                      | `Command::new`, matched by name                    |
| Cargo manifests          | `packageRoot`, `dependsOn`                                                      | from `Cargo.toml`                                  |

## Limits

- **Receivers.** Only annotated bindings and constructor results give a receiver type. Inference through
  generics, auto-deref and chained method results is out of scope for V3.
- **Tauri.** `invoke` is matched only as a bare call, and a local function named `invoke` also matches.
  Attributes on `impl` and `trait` methods are not read.
- **Recipes.** Method calls on a receiver are not matched by the configured bare-call recipe.
- **Registries across files.** A static used from another file is not matched yet.
- **Shared state.** Writes through a field are read only for a configured singleton. Writes through an
  index, and tuple-index fields such as `.0`, are not read. Plain reads of a static, such as a
  `println!` argument, are not recorded. Writes inside a `thread_local!` `with` closure are not read.
  A configured singleton that matches no static is ignored without a diagnostic.
- **Native libraries.** A `libloading` path is observation-only, not a source-level dependency. A
  `Library::new` reached through `use libloading::Library` is not read.
- **Process execution.** `Command::new` is matched by name, so a different type with the same method
  name can match.
- **Binding impl methods.** Methods in an `impl` block for a `#[napi]` class are not bound to JS.
- **Exports.** Only the library target's items are exports.

## Not applicable

- **No implicit global object.** Rust has no global object, so the global-object row does not apply. Its
  equivalent shared state is `static`, covered under Shared state.
- **No name-keyed event channels.** Rust channels connect by passing values, so name-keyed events do not
  apply. Configured method protocols still apply to types that declare both a subscribe and an emit
  method, using the same `event-like` rule as JS/TS.
- **No runtime metadata API.** Rust has no string-keyed runtime metadata API. Attributes are covered by
  the attributes entry under Registries.
- **Field and call-result receivers (scope decision).** A receiver that is a field (`self.store.save()`)
  or a call result (`make().save()`) has no type. V3 types receivers only from annotations and
  constructors, and this is recorded as a scope decision, not as Deferred.
