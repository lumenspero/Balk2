# Metadata protocols

Some frameworks record facts about a class or function with `Reflect` metadata: a route on a
controller, a parameter type, a dependency token. Metadata protocols tell Balk2 which metadata keys
matter to the project, so that the code which defines a key and the code which reads it are
connected in the map.

Nothing is matched by name alone. A key is read only when it is listed under `protocols.metadata`
in `.balk2.json`.

## Configuration

```json
{
  "protocols": {
    "metadata": [
      { "key": "route", "defines": true, "reads": true },
      { "key": "design:paramtypes", "reads": true }
    ]
  }
}
```

Each entry has:

| Field     | Meaning                                                                     |
| --------- | --------------------------------------------------------------------------- |
| `key`     | The metadata key, exactly as passed to `Reflect`. Required.                 |
| `defines` | `true` to read `Reflect.defineMetadata` and `Reflect.defineOwnMetadata` calls. |
| `reads`   | `true` to read `Reflect.getMetadata`, `getOwnMetadata`, `hasMetadata` and `hasOwnMetadata` calls. |

An entry must set `defines`, `reads`, or both to `true`. An entry with neither describes nothing and
is rejected. An unknown field, a duplicate key, or a non-boolean flag is reported and the entry is
ignored.

## What is recorded

For a configured key, the analysis creates one `metadata-key` node, with id `metadata:<key>`.
Keys are global: the same key name is one node wherever it is defined or read.

- **Defines.** `Reflect.defineMetadata('route', '/users', UsersController)` links the target symbol
  to the key with a `definesMetadata` relationship. The target is the third argument. The
  relationship runs from the target to the key.
- **Reads.** `Reflect.getMetadata('route', UsersController)` links the enclosing symbol, or the file
  at top level, to the key with a `readsMetadata` relationship. The target is the second argument.
  The relationship runs from the reader to the key.

Only the metadata key and the target are read. The metadata value is not recorded.

## Targets

A target must be a symbol the graph can name: a top-level declaration of a repository file, or a
class member. A local variable, a parameter, or a function nested in another function has no symbol,
so it cannot be a target.

## Observations

A call that the analysis cannot resolve becomes an `unresolved-metadata-key` observation, linked
from the owning symbol or file at low confidence. Two cases produce one:

- the metadata key is not a constant, such as `Reflect.getMetadata(name, Target)`;
- the target is not a top-level declaration or class member.

A `definesMetadata` edge to an `unresolved-metadata-key` node is an observation link, not a
definition. It has the type that was attempted and `low` confidence, so it is read as "this code
tried to define a metadata key and could not be resolved." A resolved definition always points at a
`metadata:` node.

## Scope

Covered:

- direct calls on the global `Reflect` name;
- the key as a string literal, a no-substitution template, or a constant that holds one.

Not covered in this version:

- **Property decorators**, and decorator helpers built on `Reflect` (for example a custom
  `@Route('/users')` that calls `Reflect.defineMetadata` internally). The defining call is inside
  the helper, where the target is a parameter, so it is an observation and not a link. If a project
  relies on such helpers, configure the decorator under `parameterDecorators` or `decorators` in
  `protocols.registries` instead.
- **Aliased `Reflect`**, such as `const r = Reflect; r.getMetadata(...)`.
- **Computed method names**, such as `Reflect[method](...)`.
- **Metadata keys held in variables** that are not `const` string constants.

## Reading the output

- **Metadata Keys section.** Each key lists the symbols that define it (`Defined on`) and the
  symbols that read it (`Read by`).
- **File and symbol sections.** A symbol that defines a key shows `Defines metadata`, and one that
  reads a key shows `Reads metadata`.
- **Unresolved Observations.** Shown with their reason and location, as for other unresolved
  mechanisms.