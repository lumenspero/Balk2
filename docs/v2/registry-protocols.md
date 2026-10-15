# Registry protocols

A registry is a string, number or class key that maps to a target: a factory name, a route, a
plugin, or a service token. Registry protocols describe the calls that register a key, look one up,
or navigate to one. This document covers the catalogue and configuration.

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

A key's type decides whether two values are the same key. It follows the container and the key:

- **string** (the default): a dictionary stores `routes[404]` and `routes['404']` as one key,
  stored as `'404'`.
- **number** (a Map, Set, class, or anything unknown): keys keep their type, so `store.get(404)`
  and `store.get('404')` are different keys. Numeric keys get a typed id, for example
  `registry:src/cache.ts:store#number:404`.
- **type** (a class used as a token): a class reference is a key of its own, so
  `container.get(UserService)` and `container.get('UserService')` are different keys. The key is
  the class name, with the id `registry:<scope>#type:UserService`. A class token is recognised only
  in a typed registry; in a dictionary it is not a key.

A class token is recognised when the identifier, or `Namespace.Class`, resolves directly to a class
declaration. An alias such as `const Token = UserService` is not followed, so it is not a key.

Arrays are not registries by default. `handlers[0] = fn` is positional, not a keyed lookup.

Events do not accept numeric names. An event name that is not a string is not an event.

## Type-argument lookups

Some containers read the key from the type argument rather than from an argument:

```ts
const service = container.resolve<UserService>();
```

A protocol with `keyFrom: "typeArgument"` takes its key from the first type argument of the call.
The key is the named class, stored as a class token, so it agrees with
`container.register(UserService, UserService)`.

A type argument that is not a named class (a generic `T`, a union, a primitive) cannot be read as a
token. The lookup is reported as a `dynamic-registry-key` observation rather than guessed. A
`keyFrom` protocol has no `keyArg`; setting both drops `keyArg` with a message.

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
        },
        { "method": "resolve", "direction": "resolve", "keyFrom": "typeArgument" }
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

Each method has `method`, `direction` (`register`, `resolve` or `route`), and one key source:

- `keyArg`: the zero-based argument that holds the key. Required unless `keyFrom` is set.
- `keyFrom`: where the key comes from when it is not an argument. The only value is `typeArgument`,
  described above. An unrecognised value rejects the entry, since falling back to `keyArg` could
  match the wrong thing.

It may also have `valueArg` (`register` only) and an optional `receiver`. A configured method
defaults to `receiver: "any"`, because naming it states the intent.

Validation follows the events section. Unusable fields are dropped with a message. A mistake that
would widen matching rejects the entry: an unrecognised receiver rule, a key and value position
that are the same, or an unknown `keyFrom`.

## Registrations without a call

Some registrations are not a call on a registry. Each of these names its registry, or is a
dictionary the code already declares, so nothing is registered by a name alone.

- **Dictionary literals.** `const routes: Record<string, unknown> = { home: Home }` registers each
  property whose value is a symbol in the repository. The declaration must be a dictionary type, so
  a plain config object such as `const options = { debug: fn }` is not a registry.
- **Decorators.** `decorators: [{ "name": "register", "registry": "src/container.ts:container" }]`
  makes `@register('user') class User` register `User` under `user`. Only the named decorator
  counts.
- **Manifest.** `manifest: [{ "registry": "...", "key": "...", "target": "..." }]` adds explicit
  registrations, for generated code. The target is a symbol id or a file path. A target missing from
  the map leaves the key without an edge.
- **Discovery.** `discover: [{ "glob": "src/commands/*.ts", "registry": "..." }]` registers each
  matching file under its name, without the extension, with the file as target. Globs are
  repository-relative; `*` stays within one segment, `**` crosses segments.

Each source adds its keys to the registry, so a lookup in the same registry agrees with them.

Known limit: a service registered through a framework's runtime wiring, with no call the analysis
can see (for example, constructor parameter injection through `@Inject`), is not connected. Add a
`manifest` entry for it.

## Joining lookups to registrations

A lookup reaches a registration when its registry and its key both agree. Both sides share one
key node (`registry:<scope>#<key>`, or the `number:` or `type:` form), so that case needs nothing
more: the path `caller -> resolves -> key -> registers -> target` is already in the map.

A lookup whose registry declares other keys, but not this one, while another registry declares it,
is recorded as `ambiguous-registry`. Its `candidates` list those other keys, and no edge chooses
among them. A lookup into a registry that declares nothing is not flagged, so an incidental
`get('user')` on an unrelated map stays silent.

## In the Markdown output and queries

- **Registries section.** Each key has its own entry: the key, its registry, what it is registered
  to, and which nodes look it up. A numeric key is marked `Key type: number`. Keys are not listed as
  symbols.
- **Lookup lines.** A file or symbol that performs a lookup shows `Resolves:` or `Routes to:` with the
  key it reaches.
- **Connection paths.** A lookup, its key and the key's target form one path:
  `caller → resolves → key → registers → target`. A key with only a registration, or only a lookup,
  produces no path. Turn these off with `pathOptions.includeRegistryKeys: false`.
- **Queries.** `getRegistryResolutions(map, nodeId)` gives what a node looks up and what each key
  maps to, `getRegistrationTargets(map, keyId)` what a key is registered to, and
  `getRegistryLookups(map, keyId)` who looks it up.

## Limits

- A `Set` registry needs `add` and `has` on its type. A custom set-like class without them needs
  configuration.
- Element access (`routes[name] = Target`) is a registration pattern handled by detection, not
  by these method protocols.
- Symbol and object keys are not supported. Class tokens are supported only in typed registries, and
  only when the class is named directly, not through an alias.
- A type argument must name a class. Generic parameters and unions are reported, not read.
