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
| `registryKeys`  | `Record<id, RegistryKeyNode>`              | Virtual nodes for string keys          |
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
it belongs to, so the same key in two containers stays two nodes. A numeric key in a typed registry
(Map, Set, class) is `registry:<scope>#number:<key>`, so `404` and `'404'` stay apart there; in a
dictionary a number is stored as its string form. Fields: `kind`, `id`, `key`, `scope`, `keyType`
(`string` or `number`).

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
`unknown-registry-receiver`, `ambiguous-registry`, `dynamic-state-path`), `attempted` (the
relationship type that would have been created), `subject`, `location` (a source span), and
`candidates` when the problem is ambiguity, and an optional one-sentence `detail` saying why it
could not be resolved. The owning symbol or file links to it with a
`low`-confidence relationship of the attempted type.

## Relationships

`type`, `from`, `to` and `confidence` (`high` | `medium` | `low`) are always present. Optional:

- `evidence`: `ast`, `ts-program`, `config` or `heuristic`.
- `spans`: source ranges (`filePath`, `startLine`, `startColumn`, `endLine`, `endColumn`, 1-based).
- `metadata`: mechanism details, for example `{ "once": true }` on a `subscribes` edge.

A relationship is identified by `(type, from, to)`. Repeated observations are merged: the
highest confidence (and its evidence) wins, spans are combined, and `metadata` keeps only the keys
that carry the same value in every observation, so a flag seen on one registration is never claimed
for them all.

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
- A version 2 map written before registry keys or state paths existed reads with an empty
  `registryKeys` or `statePaths` table.
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
