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
| `unresolved`    | `Record<id, UnresolvedReferenceNode>`      | Diagnostics for ambiguous/dynamic code |
| `relationships` | `Relationship[]`                           | Sorted by `(type, from, to)`           |

Every table is sorted by key and relationships by `(type, from, to)` using ordinal string
comparison, so output is identical across machines for identical input.

## Virtual nodes

**Event channel** — `event:<name>`, or `event:<scope>#<name>` when the emitter/receiver identity
is resolved. `socket.emit('ready')` and `document.dispatchEvent(new Event('ready'))` therefore
produce different channels. Fields: `kind`, `id`, `name`, optional `scope`.

**Unresolved reference** — `unresolved:<reason>:<file>:<line>:<column>`. Records code that looks
like a connection but cannot be resolved without guessing. Fields: `kind`, `id`, `reason`
(`ambiguous-global`, `dynamic-event-name`, `unknown-event-receiver`), `attempted` (the
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
highest confidence (and its evidence) wins and spans are combined.

Event relationships are `emits`, `dispatches`, `subscribes` and `unsubscribes`. They point from the
publisher or listener owner **to** the channel; reverse links are derived when rendering or
querying and are never stored. Existing families (`imports`/`importedBy`, `calls`/`calledBy`, ...)
still store both directions in this version.

## Reading older maps

`deserializeConnectionMap` accepts version 1 and version 2.

- A version 1 map is converted on read: its nodes and relationships are valid in version 2
  unchanged, and `eventChannels` and `unresolved` start empty.
- Any other version is rejected with `Unsupported connection map version`.
- `balk2 check` compares the on-disk file with a freshly generated one, so a version 1 file is
  reported as out of date until it is regenerated.

## Compatibility

The exported `ConnectionMap` type now has `version: 2` and two new tables, which is a breaking
change for TypeScript consumers; `ConnectionMapV1` is exported for code that still handles the
old shape. This change ships with the next major version.
