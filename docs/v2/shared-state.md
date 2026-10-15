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

- `true` tracks top-level global properties that the repository assigns somewhere.
- A list tracks only those top-level names.
- `false` tracks none.

Browser and runtime built-ins such as `window.location` are therefore not state unless you list
them. A list with no valid names is reported and the default is kept.

**Singletons.** `module` is relative to the repository and `export` is an export name or
`default`. Its node root is `<module>:<export>`. Only exports listed here are treated as state;
Balk2 does not guess which exported objects are shared.

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