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
