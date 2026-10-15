# Shared state

Balk2 records which code reads, writes and deletes shared state, as `readsState`, `writesState` and
`deletesState` relationships to `state-path` nodes (see `connection-map-schema.md`). This is data
coupling, kept separate from imports and calls.

## Configuration

The `state` section of `.balk2.json` says what counts as shared state. Every field is optional.

```json
{
  "state": {
    "roots": ["__APP_STATE__"],
    "globals": ["store"],
    "singletons": [{ "module": "src/store.ts", "export": "store" }],
    "methods": [{ "method": "select", "access": "read", "keyArg": 0, "pathSeparator": "." }],
    "disable": ["has"],
    "dynamicPaths": "off"
  }
}
```

| Field          | Default | Meaning                                                                          |
| -------------- | ------- | -------------------------------------------------------------------------------- |
| `roots`        | none    | Free identifiers that are shared state objects, such as a bundler-injected value |
| `globals`      | `true`  | State under the global object (see below)                                        |
| `singletons`   | none    | Module exports that hold shared state                                            |
| `builtIns`     | `true`  | Whether the built-in state methods apply                                         |
| `disable`      | none    | Built-in methods to turn off                                                     |
| `methods`      | none    | Project-specific state methods; one named like a built-in replaces it            |
| `dynamicPaths` | `off`   | `off` reports a computed property; `wildcard` records it as `[*]`                |

**Roots.** A configured root is matched only where the name is free. A local variable or import
that happens to share the name is not the root. Its node root is `config:<name>`.

**Globals.** The global object goes by the names in `globals.roots` (`globalThis`, `window`,
`self` and `global` by default), and all of them share one `global` state root.

- `true` tracks top-level globals the repository establishes as data. That means a script-scope or
  ambient variable (`var appState = {}`), or a property assigned through the global object
  (`window.store = {}`). A global function or class is not state. An assigned path such as
  `window.App.init = fn` still makes the namespace `App` state.
- A list tracks only those top-level names, whether or not the repository assigns them. This suits
  values injected by a server or bundler.
- `false` tracks none.

The same name reaches the same node through any route: `window.store.user`, `globalThis.store.user`
and a bare `store.user` are all `state:global#store.user`. Browser and runtime built-ins such as
`window.location` are not state unless you list them. A local variable or parameter that shadows a
global, or the global object itself, is never state. A computed first property (`window[key]`) is
not resolved, since which global it names is unknown. A list with no valid names is reported and
the default is kept.

**Singletons.** `module` is relative to the repository and `export` is an export name or
`default`. Its node root is `<module>:<export>`. Only exports listed here are treated as state;
Balk2 does not guess which exported objects are shared. The export is matched by symbol, so a
renamed import, a namespace import (`ns.store`) and a default import all reach it. A different
module's export with the same name does not. A singleton whose module is not analyzed, or that
has no such export, is reported and ignored.

**Aliases.** `const cart = store.cart` and `const { cart } = store` are followed, so later
`cart.items` is `store#cart.items`. A path reached through such an alias is recorded at `medium`
confidence. `let` and `var` bindings and parameters are not followed, since what they hold can
change.

## What counts as an access

Only the outermost expression of a property chain is an access. `store.cart.items = []` writes
`cart.items`; it does not also read `store` or `store.cart`. Reading `store` itself (passing it to a
function, say) is a read of the container, a different node from any of its properties.

| Code                                            | Relationship               | `operation`       |
| ----------------------------------------------- | -------------------------- | ----------------- |
| `render(store.user)`                            | `readsState`               | `read`            |
| `store.user = u`, `window.store = {}`           | `writesState`              | `assign`          |
| `({ a: store.x } = o)`, `for (store.y of list)` | `writesState`              | `assign`          |
| `store.count += 1`, `store.flag ??= true`       | `readsState`+`writesState` | `compound-assign` |
| `store.count++`, `--store.count`                | `readsState`+`writesState` | `increment`       |
| `delete store.cache`                            | `deletesState`             | `delete`          |
| `const { cart, user: { name } } = store`        | `readsState` per binding   | `read`            |

**Calls are not data access.** `store.items.push(x)` and `App.init()` record nothing, since calling
a method is behavior, not a read of a value. State passed as an argument is still read.
`store.get('user')` is recorded only when `get` is a state method (see below).

**Declarations are not writes.** `export const store = {...}` and `var appState = {...}` create
state; only later assignments are writes. An assignment through the global object
(`window.store = {}`) is a write.

`const` destructuring reads each bound path rather than the whole container. A `let` or `var`
destructuring, or one with a rest element or a computed key, reads the container.

A computed property whose key is not statically known (`store[key]`) is recorded according to
`dynamicPaths`. With the default `off` it becomes a `dynamic-state-path` observation; with
`wildcard` it becomes a path with a `[*]` segment, for example `store#cache[*].value`. A computed
key that is a constant or literal (`store[KEY]`, `store[0]`) is static.

Known limit: a mutating method such as `push` or `splice` on a state array is not recorded as a
write unless it is configured as a state method.

## State methods

A state method is a call on something that already resolves to a state root. A `get` on an
unrelated object is never a state access, which is what makes the built-ins safe defaults:

| Method      | Access | Key argument | Example                                     |
| ----------- | ------ | ------------ | ------------------------------------------- |
| `get`       | read   | 0            | `store.get('user')` reads `user`            |
| `has`       | read   | 0            | `store.has('user')` reads `user`            |
| `subscribe` | read   | none         | `store.subscribe(fn)` reads the whole store |
| `set`       | write  | 0            | `store.set('user', u)` writes `user`        |
| `delete`    | delete | 0            | `store.delete('user')` deletes `user`       |

A project method has `method`, `access` (`read`, `write` or `delete`), an optional `keyArg`, and
an optional `pathSeparator`. Without `keyArg`, the call touches the receiver itself.
`pathSeparator` splits a single string key into a path, so with `"."`, `select('session.user')`
touches `session.user`.

An entry that could widen what a call touches is rejected whole. This covers a missing or unknown
`access`, a malformed `keyArg`, and a bad method name. A misused `pathSeparator` drops only that
field. Every dropped setting is reported by `loadBalk2ConfigDetailed`.

When a call on a state root also matches a registry method (for example `cache.get('x')` on a
configured `Map` singleton), it is recorded as state, not as a registry lookup.
