# Connection map schema

`connection-map.json` is the canonical output of Balk2. It is versioned by the top-level
`version` field. This document describes **version 2** and the policy for reading older maps.

## Top level

| Field           | Type                                       | Notes                                  |
| --------------- | ------------------------------------------ | -------------------------------------- |
| `version`       | `2`                                        | Schema version                         |
| `repository`    | `{ commit?: string, generatedAt: string }` | Generation metadata                    |
| `files`         | `Record<path, FileNode>`                   | Code files                             |
| `symbols`       | `Record<id, SymbolNode>`                   | `filePath:name`                        |
| `artifacts`     | `Record<path, ArtifactNode>`               | Data files                             |
| `eventChannels` | `Record<id, EventChannelNode>`             | Virtual nodes for event names          |
| `registryKeys`  | `Record<id, RegistryKeyNode>`              | Virtual nodes for keys                 |
| `statePaths`    | `Record<id, StatePathNode>`                | Virtual nodes for shared state         |
| `unresolved`    | `Record<id, UnresolvedReferenceNode>`      | Diagnostics for ambiguous/dynamic code |
| `relationships` | `Relationship[]`                           | Sorted by `(type, from, to)`           |

Every table is sorted by key and relationships by `(type, from, to)` using ordinal string
comparison, so output is identical across machines for identical input.

## Virtual nodes

**Event channel** — `event:<name>`, or `event:<scope>#<name>` when the emitter/receiver identity
is resolved. `socket.emit('ready')` and `document.dispatchEvent(new Event('ready'))` therefore
produce different channels. Fields: `kind`, `id`, `name`, optional `scope`.

**Registry key** — `registry:<scope>#<key>`. A key scoped to the resolved identity of the registry
it belongs to, so the same key in two containers stays two nodes. The id form depends on the key
type:

| `keyType` | Id                              | Example                                                |
| --------- | ------------------------------- | ------------------------------------------------------ |
| `string`  | `registry:<scope>#<key>`        | `registry:src/routes.ts:routes#home`                   |
| `number`  | `registry:<scope>#number:<key>` | `registry:src/cache.ts:store#number:404`               |
| `type`    | `registry:<scope>#type:<name>`  | `registry:src/container.ts:container#type:UserService` |

A numeric key in a typed registry (Map, Set, class) is `number`, so `404` and `'404'` stay apart
there; in a dictionary a number is stored as its string form. A class used as a token is `type`,
keyed by the class name, so `UserService` (the class) and `'UserService'` (the string) stay apart in
a typed registry. A class token has no key in a dictionary.

Fields: `kind`, `id`, `key`, `scope`, `keyType` (`string`, `number` or `type`). For a `type` key,
`key` is the class name.

A registry key is created only for a registry the analysis trusts. A dictionary, a configured name
or type, or a Map or Set with evidence of repository symbols (a declared key, or a registration
whose value resolves to a symbol or file in the same registry) counts. A Map or Set that holds only
runtime values does not, so its dynamic-key calls produce no observations. A static-key lookup on
such a receiver still forms its `resolves` edge and key node, since it names a key the graph can
show.

**State path** — `state:<root>` for a state container, `state:<root>#<path>` for a property under
it, so reading a whole store and reading one field of it are different nodes. The root is the
resolved identity of the shared object:

| `rootKind`   | `root`            | Example id                            |
| ------------ | ----------------- | ------------------------------------- |
| `global`     | `global`          | `state:global#store.session.user`     |
| `configured` | `config:<name>`   | `state:config:appState#theme`         |
| `singleton`  | `<file>:<export>` | `state:src/store.ts:store#cart.items` |

Every name for the global object (`globalThis`, `window`, `self`, `global`, configured roots and
their aliases) shares the one `global` root. In the path, identifier names are joined with `.`; any
other name is written `["name"]` with JSON escaping, and a computed property whose name is not
statically known is `[*]`. Wildcards appear only when dynamic paths are enabled; otherwise the
access is an unresolved `dynamic-state-path` observation. Fields: `kind`, `id`, `root`, `rootKind`,
`path` (the display form, empty for the container) and `segments` (the property names, with `null`
for a wildcard).

**Unresolved reference** — `unresolved:<reason>:<file>:<line>:<column>`. Records code that looks
like a connection but cannot be resolved without guessing. Fields: `kind`, `id`, `reason`
(`ambiguous-global`, `dynamic-event-name`, `unknown-event-receiver`, `dynamic-registry-key`,
`unknown-registry-receiver`, `ambiguous-registry`, `dynamic-state-path`, `dynamic-module-specifier`),
`attempted` (the relationship type that would have been created), `subject`, `location` (a source
span), and `candidates` when the problem is ambiguity, and an optional one-sentence `detail` saying
why it could not be resolved. The owning symbol or file links to it with a `low`-confidence
relationship of the attempted type.

## Relationships

`type`, `from`, `to` and `confidence` (`high` | `medium` | `low`) are always present. Optional:

- `evidence`: `ast`, `ts-program`, `config` or `heuristic`.
- `spans`: source ranges (`filePath`, `startLine`, `startColumn`, `endLine`, `endColumn`, 1-based).
- `metadata`: mechanism details, for example `{ "once": true }` on a `subscribes` edge, or
  `{ "loadKind": "worker" }` on an `imports` edge from a dynamic load.

A relationship is identified by `(type, from, to)`. Repeated observations are merged: the
highest confidence (and its evidence) wins, and spans are combined. Metadata is merged by key:

- Most keys, such as `once`, are kept only when every observation carries the same value, so a flag
  seen on one registration is never claimed for them all.
- `loadKind` is **combinable**. Its values are joined as a sorted, comma-separated list, so a file
  that is both required and dynamically imported from the same owner reads
  `"import-expression,require"`. The combinable keys are listed in `COMBINABLE_METADATA`.

Event relationships are `emits`, `dispatches`, `subscribes` and `unsubscribes`. They point from the
publisher or listener owner **to** the channel.

Registry relationships are `registers`, `resolves` and `routesTo`. `registers` runs from a registry
key to the symbol or file it maps to. `resolves` and `routesTo` run from a caller to the key it
looks up.

State relationships are `readsState`, `writesState` and `deletesState`. They point from the symbol
or file that touches the state **to** the state-path node, and record how in `metadata.operation`:
`read`, `assign`, `compound-assign` (`+=` and the like), `increment` (`++`/`--`), `delete`, or
`call` for a state API such as `store.set('user', u)`, with the method name in `metadata.method`.
State relationships are data coupling, not structural dependency: path ranking leaves them out
unless asked.

**Every relationship is stored once, in its forward direction.** There is no `importedBy`,
`calledBy`, `generatedBy` or `consumedBy` in a generated map: who imports a file, who calls a
function and what consumes a data file are derived when reading (see "Reading the graph"). Those
four names remain in the type definitions only so older maps can be read, and
`ConnectionGraph.addRelationship` stores the forward relationship when it is given one.

### Dynamic module loads

Module loads that the analysis can see are recorded as `imports` relationships. The source of the
load determines the edge:

| Written as                                     | `loadKind`          | Edge                                                        |
| ---------------------------------------------- | ------------------- | ----------------------------------------------------------- |
| `import('./x')` with a constant specifier      | `import-expression` | owner → file, when the file resolves inside the repository  |
| `new Worker(new URL('./x', import.meta.url))`  | `worker`            | owner → file                                                |
| `new URL('./x', import.meta.url)` elsewhere    | `url`               | owner → file                                                |
| A configured loader call (`protocols.loaders`) | `loader`            | owner → file                                                |
| `require('./x')` (literal)                     | none                | file or owner → file; carries no `loadKind` in this version |

The owner is the enclosing symbol when there is one (for example `src/app.ts:loadPlugin`), and the
file at top level.

Three rules keep dynamic loads from changing existing output:

- **Absorption.** A load whose owner already has an `imports` edge to the same file adds nothing.
  The static edge is never restamped with `loadKind`. A top-level `import()` of a file the same
  file already imports statically is therefore silent.
- **External and missing targets are silent.** A package specifier (`import('left-pad')`) and a
  relative specifier that names no repository file produce no edge and no observation.
- **Computed specifiers are observations.** A specifier that is not a constant, such as
  `import(\`./${name}.js\`)`or`loadPlugin(name)`, produces a `dynamic-module-specifier`observation. The owner links to it with a`low`-confidence `imports`relationship whose`loadKind` says how it loads. No edge names a target.

## Reading the graph

A relationship is stored once, from the thing that acts to the thing it acts on. Version 1 maps also
stored a reverse link for some families (`importedBy`, `calledBy`, `generatedBy`, `consumedBy`), so
a fact appeared twice. Maps no longer do, and code that reads the JSON should not look for them.
These helpers answer the same questions for any map, old or new:

```ts
import { getIncoming, getOutgoing, forwardRelationships } from '@lumenspero/balk2';

getIncoming(map, 'src/util.ts:help', 'calls'); // who calls help?
getOutgoing(map, 'src/main.ts:run', 'calls'); // what does run call?
getIncoming(map, 'src/util.ts', 'imports'); // who imports util.ts?
```

`forwardRelationships(map)` returns every relationship in forward form: any stored reverse link is
turned around, repeated facts are merged at their highest confidence, and the result is sorted. The
generated `connection-map.md` derives its "Imported by" and "Called by" lists the same way, so
it reads identically for a map that stores reverse links and one that does not.

For event channels there are two direct questions:

```ts
import { getEventReactions, getEventTriggers } from '@lumenspero/balk2';

getEventReactions(map, 'src/net.ts:connect'); // what reacts when this emits?
getEventTriggers(map, 'src/ui.ts:onReady'); // what can make this listener run?
```

Both return the channel and the nodes on the other side of it, sorted. Unresolved observations are
not channels and are never included.

## Reading older maps

`deserializeConnectionMap` accepts version 1 and version 2.

- A version 1 map is converted on read: its nodes are valid in version 2 unchanged,
  `eventChannels`, `registryKeys`, `statePaths` and `unresolved` start empty, and stored reverse
  links are turned into the forward relationship they repeat, so each fact is held once.
- A version 2 map written before registry keys, state paths, or `type` keys existed reads with the
  missing tables empty. A map with no `type` keys is unchanged.
- A version 2 map written while reverse links were still stored is cleaned the same way, so
  `deserializeConnectionMap` always returns relationships in canonical form.
- Any other version is rejected with `Unsupported connection map version`.
- `balk2 check` compares the on-disk file with a freshly generated one, so a version 1 file, or a
  version 2 file that still contains reverse links, is reported as out of date until it is
  regenerated.

## Compatibility

The exported `ConnectionMap` type now has `version: 2` and four new tables (`eventChannels`,
`registryKeys`, `statePaths`, `unresolved`), which is a breaking
change for TypeScript consumers; `ConnectionMapV1` is exported for code that still handles the
old shape. This change ships with the next major version.

`RegistryKeyType` gained `'type'`. Code that switches over `keyType` exhaustively must handle it.
