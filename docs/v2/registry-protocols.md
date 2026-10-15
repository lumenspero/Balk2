# Registry protocols

A registry is a string or number key that maps to a target: a factory name, a route, a plugin.
Registry protocols describe the calls that register a key, look one up, or navigate to one. This
document covers the catalogue and configuration. Detection of registrations and lookups in code
is a later step.

## Directions and relationships

| Direction  | Meaning                                             | Relationship |
| ---------- | --------------------------------------------------- | ------------ |
| `register` | stores a key, optionally with the target it maps to | `registers`  |
| `resolve`  | looks a key up and gets its target                  | `resolves`   |
| `route`    | navigates to a key                                  | `routesTo`   |

`registers` runs from a registry key to the symbol or file it maps to. `resolves` and `routesTo`
run from the calling code to the key. A lookup connects to a registration only when both name the
same registry identity and key.

## Built-in methods

| Method     | Direction  | Key | Target |
| ---------- | ---------- | --- | ------ |
| `register` | `register` | 0   | 1      |
| `set`      | `register` | 0   | 1      |
| `add`      | `register` | 0   | none   |
| `get`      | `resolve`  | 0   | none   |
| `resolve`  | `resolve`  | 0   | none   |
| `create`   | `resolve`  | 0   | none   |
| `load`     | `resolve`  | 0   | none   |
| `navigate` | `route`    | 0   | none   |

Every built-in requires a **registry-like** receiver. A generic name such as `get` or `set` is only
mapped on a receiver that is a registry, so `cache.get('x')` on an unrelated object is ignored.

## Registry-like receivers

A receiver is a registry when its type is one of:

- a **dictionary**: it has an index signature. Arrays are excluded, because their keys are
  positions rather than names;
- **set-like**: it has both `add` and `has`;
- a type with at least one register method and at least one lookup method of the active catalog.

A receiver of unknown type never qualifies. A configured receiver rule (`names` or `types`) is
checked instead, and is trusted as written.

## Key types

A key's type decides whether `1` and `'1'` are the same key. It follows the container:

- **object** (a dictionary): JavaScript converts every key to a string, so `routes[404]` and
  `routes['404']` are one key, stored as `'404'`.
- **typed** (a Map, Set, class, or anything unknown): keys keep their type, so `store.get(404)`
  and `store.get('404')` are different keys. Numeric keys get a typed id, for example
  `registry:src/cache.ts:store#number:404`.

Arrays are not registries by default. `handlers[0] = fn` is positional, not a keyed lookup.

Events do not accept numeric names. An event name that is not a string is not an event.

## Configuration

Registry protocols are configured under `protocols.registries` in `.balk2.json`:

```json
{
  "protocols": {
    "registries": {
      "builtIns": true,
      "disable": ["add"],
      "methods": [
        { "method": "lookupRoute", "direction": "route", "keyArg": 0 },
        {
          "method": "put",
          "direction": "register",
          "keyArg": 0,
          "valueArg": 1,
          "receiver": { "names": ["container"] }
        }
      ]
    }
  }
}
```

| Field      | Meaning                                                           |
| ---------- | ----------------------------------------------------------------- |
| `builtIns` | Use the built-in catalogue (default `true`)                       |
| `disable`  | Built-in methods to stop mapping. They still count as evidence    |
| `methods`  | Project methods. One with the same name as a built-in replaces it |

Each method has `method`, `direction` (`register`, `resolve` or `route`), `keyArg` (required),
`valueArg` (`register` only) and an optional `receiver`. A configured method defaults to
`receiver: "any"`, because naming it states the intent.

Validation follows the events section. Unusable fields are dropped with a message. A mistake that
would widen matching rejects the entry: an unrecognised receiver rule, or a key and value position
that are the same.

## Limits

- A `Set` registry needs `add` and `has` on its type. A custom set-like class without them needs
  configuration.
- Element access (`routes[name] = Target`) is a registration pattern handled by detection, not
  by these method protocols.
- Symbol and object keys are not supported; they are not string or number keys.
