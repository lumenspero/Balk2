# Rust: registries

Rust registries are read in three forms. Each is configured or read from source; none is inferred from
a framework by default.

## Local maps

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

## Static maps

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

## Literal tables and `lazy_static!`

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

## Attributes (registration by declaration)

An attribute on a free function or type declares the item under a key. A Tauri command uses the
configuration below.

## Tauri commands (recipe)

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

## Configured bare calls (recipe)

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

## Shared state

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

## Callbacks

- `thread::spawn(f)` and `std::thread::spawn(f)` are read when no repository symbol has that path.
- `map`, `filter`, `for_each`, `filter_map` and `flat_map` are read by method name, whatever the
  receiver is. The receiver's type is not checked.
- A closure is inline. A path that names a repository function links to it. Any other argument is an
  unresolved observation at low confidence.

## Native libraries

`libloading::Library::new(path)` loads a shared library at run time, and the library's code is not
analyzed. A string-literal path is recorded as an `unresolved-module-path` observation, and any other
path as a `dynamic-module-specifier` observation, both from the function that makes the load. Only the
full path is read. A `Library::new` reached through `use libloading::Library` is not read yet.

## Source annotations

A `// balk2:` line comment directly above a statement can set confidence, and must name the innermost
function that holds the statement, or the file at top level. Doc comments (`///`, `//!`) and text inside
a string are not directives.
