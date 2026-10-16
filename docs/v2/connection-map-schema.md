# Connection map schema

`connection-map.json` is the canonical output of Balk2. It is versioned by the top-level
`version` field. This document describes **version 2** and the policy for reading older maps.

## Top level

| Field           | Type                                       | Notes                                             |
| --------------- | ------------------------------------------ | ------------------------------------------------- |
| `version`       | `2`                                        | Schema version                                    |
| `repository`    | `{ commit?: string, generatedAt: string }` | Generation metadata                               |
| `files`         | `Record<path, FileNode>`                   | Code files                                        |
| `symbols`       | `Record<id, SymbolNode>`                   | `filePath:name`                                   |
| `artifacts`     | `Record<path, ArtifactNode>`               | Data files                                        |
| `eventChannels` | `Record<id, EventChannelNode>`             | Virtual nodes for event names                     |
| `registryKeys`  | `Record<id, RegistryKeyNode>`              | Virtual nodes for registry keys                   |
| `metadataKeys`  | `Record<id, MetadataKeyNode>`              | Virtual nodes for `Reflect` metadata keys         |
| `resources`     | `Record<id, ResourceNode>`                 | Virtual nodes for templates, stylesheets, schemas |
| `statePaths`    | `Record<id, StatePathNode>`                | Virtual nodes for shared state                    |
| `unresolved`    | `Record<id, UnresolvedReferenceNode>`      | Diagnostics for ambiguous or dynamic code         |
| `relationships` | `Relationship[]`                           | Sorted by `(type, from, to)`                      |

Every table is sorted by key and relationships by `(type, from, to)` using ordinal string
comparison, so output is identical across machines for identical input. The virtual tables are
written in the order shown above.

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

A registration's target must be declared at the top level of a repository file, or be a class
member. A local variable, a parameter, or a function nested in another function is not a target,
so a value stored from inside a function does not register that function.

**Metadata key** — `metadata:<key>`. A `Reflect` metadata key listed in `protocols.metadata`. Keys
are global, so the same key name is one node across the repository. Fields: `kind`, `id`, `key`.
Created only for keys that are configured and used.

**Resource** — `resource:<path>`. A template, stylesheet or schema file that code uses, identified
by its repository-relative path. Fields: `kind`, `id`, `path`, `resourceKind` (`template`,
`stylesheet` or `schema`). Created only for files that exist in the repository and are used. A
plain `.json` file is a data artifact, not a resource; a `*.schema.json` file is a schema resource,
not a data artifact.

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
like a connection but cannot be resolved without guessing. Fields: `kind`, `id`, `reason`,
`attempted` (the relationship type that would have been created), `subject`, `location` (a source
span), optional `candidates` when the problem is ambiguity, and an optional one-sentence `detail`.

`reason` is one of:

| Reason                       | Raised when                                                      |
| ---------------------------- | ---------------------------------------------------------------- |
| `ambiguous-global`           | a global name is declared in several files without a target      |
| `dynamic-event-name`         | an event name is not a constant                                  |
| `unknown-event-receiver`     | an event call's receiver type is not known                       |
| `dynamic-registry-key`       | a registry key, or an injected token, is not readable            |
| `unknown-registry-receiver`  | a registry call's receiver is not a known registry               |
| `ambiguous-registry`         | a lookup's key is absent from its registry but present elsewhere |
| `dynamic-state-path`         | a state access has a computed property and wildcards are off     |
| `dynamic-module-specifier`   | a dynamic module load's specifier is not a constant or literal   |
| `unresolved-callback`        | a configured callback is not a top-level function or variable    |
| `unresolved-metadata-key`    | a metadata key is not a constant, or its target has no symbol    |
| `dynamic-resource-specifier` | a loader's resource path is not a constant                       |

The owning symbol or file links to an unresolved node with a `low`-confidence relationship of the
attempted type. That link is an observation, not a resolution: a `calls` edge to an unresolved node
is "this code tried to call something and could not be resolved."

## Relationships

`type`, `from`, `to` and `confidence` (`high` | `medium` | `low`) are always present. Optional:

- `evidence`: `ast`, `ts-program`, `config` or `heuristic`.
- `spans`: source ranges (`filePath`, `startLine`, `startColumn`, `endLine`, `endColumn`, 1-based).
- `metadata`: mechanism details, for example:
  - `{ "once": true }` on a `subscribes` edge;
  - `{ "loadKind": "worker" }` on an `imports` edge from a dynamic load;
  - `{ "loadKind": "import-module" }` on an `imports` edge from a Python `importlib.import_module` call;
  - `{ "inline": true }` on a `passesCallback` edge from an inline callback;
  - `{ "injection": "constructor" }` on a `resolves` edge from a constructor parameter decorator;
  - `{ "resourceKind": "stylesheet", "mechanism": "import" }` on a `usesResource` edge;
  - `{ "annotated": true }` on any relationship a project annotation has decided.

A relationship is identified by `(type, from, to)`. Repeated observations are merged: the
highest confidence (and its evidence) wins, and spans are combined. Metadata is merged by key:

- Most keys, such as `once` and `injection`, are kept only when every observation carries the same
  value, so a flag seen on one registration is never claimed for them all.
- `loadKind` is **combinable**. Its values are joined as a sorted, comma-separated list, so a file
  that is both required and dynamically imported from the same owner reads
  `"import-expression,require"`. The combinable keys are listed in `COMBINABLE_METADATA`.

An annotated relationship carries `evidence: "config"` and `metadata.annotated: true`. The confidence
is the one the project set, and may be higher or lower than the detector's. The original detector
evidence is replaced, so the map does not keep it for an annotated edge. See `annotations.md`.

Event relationships are `emits`, `dispatches`, `subscribes` and `unsubscribes`. They point from the
publisher or listener owner **to** the channel.

Registry relationships are `registers`, `resolves` and `routesTo`. `registers` runs from a registry
key to the symbol or file it maps to. `resolves` and `routesTo` run from a caller to the key it
looks up. A `resolves` edge with `metadata.injection` runs from a class to the key it depends on,
as described under "Constructor injection" in the registry protocols document.

Metadata relationships are `definesMetadata` and `readsMetadata`. `definesMetadata` runs from the
target symbol to the metadata key it carries. `readsMetadata` runs from the enclosing owner of a
read to the same key. A `definesMetadata` or `readsMetadata` edge whose target is an
`unresolved-metadata-key` node is an observation link, not a resolved definition or read. See
`metadata-protocols.md`.

Resource relationships are `usesResource`. It runs from the file or symbol that uses a resource to
the resource node. `metadata.mechanism` is `import` for a static import or `loader` for a configured
loader call. A `usesResource` edge whose target is a `dynamic-resource-specifier` observation is a
link to an unresolved use. See `resource-protocols.md`.

`passesCallback` runs from the function that passes a callback to the callback's symbol. See
"Callbacks" below.

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

| Written as                                       | `loadKind`          | Edge                                                        |
| ------------------------------------------------ | ------------------- | ----------------------------------------------------------- |
| `import('./x')` with a constant specifier        | `import-expression` | owner → file, when the file resolves inside the repository  |
| `new Worker(new URL('./x', import.meta.url))`    | `worker`            | owner → file                                                |
| `new URL('./x', import.meta.url)` elsewhere      | `url`               | owner → file                                                |
| A configured loader call (`protocols.loaders`)   | `loader`            | owner → file                                                |
| `importlib.import_module('x')` (Python, literal) | `import-module`     | owner → file, when the file is in the repository            |
| `require('./x')` (literal)                       | none                | file or owner → file; carries no `loadKind` in this version |

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

### Callbacks

A configured function (`protocols.callbacks`) that receives a callback is recorded as a
`passesCallback` relationship from the caller. The callback is passed, not invoked, so no `calls`
edge is drawn for it.

| Callback argument                                                                        | Edge                                              |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------- |
| A function or arrow function written inline                                              | caller → caller, `high`, `metadata.inline: true`  |
| An identifier naming a top-level function or variable                                    | caller → that symbol, `high`, `ts-program`        |
| Anything else from the repository (a parameter, a local, a call such as `makeHandler()`) | caller → `unresolved-callback` observation, `low` |
| An identifier or call from an external module                                            | none                                              |

An inline callback has no symbol of its own, so its edge targets the enclosing symbol. In the
Markdown output it is shown as `(inline)`. Locals are not linked: a local function has no symbol in
the graph, and linking it to the function that declares it would be a guess.

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
  `eventChannels`, `registryKeys`, `metadataKeys`, `resources`, `statePaths` and `unresolved` start
  empty, and stored reverse links are turned into the forward relationship they repeat, so each fact
  is held once.
- A version 2 map written before any of the virtual tables existed reads with the missing tables
  empty. A map with no `type` keys, metadata keys or resources is unchanged.
- A version 2 map written while reverse links were still stored is cleaned the same way, so
  `deserializeConnectionMap` always returns relationships in canonical form.
- Any other version is rejected with `Unsupported connection map version`.
- `balk2 check` compares the on-disk file with a freshly generated one, so a version 1 file, or a
  version 2 file that still contains reverse links, is reported as out of date until it is
  regenerated.

## Compatibility

The exported `ConnectionMap` type now has `version: 2` and six new tables (`eventChannels`,
`registryKeys`, `metadataKeys`, `resources`, `statePaths`, `unresolved`), which is a breaking change
for TypeScript consumers; `ConnectionMapV1` is exported for code that still handles the old shape.
This change ships with the next major version.

The enumerated types changed as follows. Code that switches over any of them exhaustively must
handle the new values:

- `RegistryKeyType` gained `'type'`.
- `UnresolvedReason` gained `'unresolved-callback'`, `'unresolved-metadata-key'` and
  `'dynamic-resource-specifier'`.
- `CodeRelationship` gained `'passesCallback'`.
- The relationship union gained `definesMetadata`, `readsMetadata` and `usesResource`.
- `NodeKind` and `GraphNode` gained `'metadata-key'` and `'resource'`.
- `LoadKind` gained `'import-module'`.

Annotated relationships change `evidence` to `config`. A consumer that read `ast` or `ts-program`
from an edge that is now annotated will see `config` instead.

Existing outputs change in three places on regeneration: repositories that import stylesheets or
templates gain `usesResource` edges and a `Resources` section; annotated edges show `config`
evidence; and Python files that call `importlib.import_module` with a literal gain `import-module`
edges. These belong in the release notes.
