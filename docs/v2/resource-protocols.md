# Resource protocols

A resource is a non-code file that code uses: a markup template, a stylesheet, or a JSON schema.
Resources are recorded so that a file which imports a stylesheet, or renders a template, is
connected to that file in the map.

Resources are kept apart from the other tables. A code file is a `file`, a data file is an
`artifact`, and a template, stylesheet or schema is a `resource`.

## What counts as a resource

| Extension                                                   | `resourceKind` |
| ----------------------------------------------------------- | -------------- |
| `.html`, `.htm`, `.hbs`, `.handlebars`, `.ejs`, `.mustache` | `template`     |
| `.css`, `.scss`, `.sass`, `.less`                           | `stylesheet`   |
| `*.schema.json`                                             | `schema`       |

A plain `.json` file is a data artifact, not a resource. A `*.schema.json` file is a schema and is
not a data artifact, so it does not appear in the Data Connections section.

## How resources are used

Two mechanisms are recorded. Both produce a `usesResource` relationship from the user to the
resource node, with `metadata.resourceKind` and `metadata.mechanism`.

**Static import (`mechanism: import`).** A relative import of a resource file links the importing
file:

```ts
import './app.css';
import tpl from './page.html?raw';
import schema from './user.schema.json';
```

The `?query` suffix (`?raw`, `?url`) is ignored. Only relative specifiers count, since a bare
specifier names a package.

**Configured loader (`mechanism: loader`).** A function configured under `protocols.resources`
links its enclosing symbol to the resource whose path it receives:

```json
{
  "protocols": {
    "resources": [{ "function": "loadTemplate", "specifierArg": 0 }]
  }
}
```

```ts
export function render(): string {
  return loadTemplate('tpl/card.html');
}
```

Here `render` gets a `usesResource` edge to `resource:tpl/card.html`. A path starting with `.`
resolves relative to the calling file. Any other path resolves from the repository root.

Nothing is inferred from `fs` reads, so `readFileSync(join(__dirname, 'x.html'))` is not recorded.

## Rules

- **A file must exist.** A path that names no file inside the repository produces no edge and no
  observation, the same rule external modules follow.
- **A computed path is an observation.** A loader call whose path is not a constant, such as
  `loadTemplate(name)`, produces a `dynamic-resource-specifier` observation, linked from the owner
  at low confidence. No edge names a resource.
- **Static imports need no configuration.** Only loader calls depend on `protocols.resources`.

## Scope

Not covered in this version:

- `fs` reads of resource files;
- resources referenced only from configuration or HTML (for example `<link href="app.css">`);
- aliased loader functions and computed function names.

## Reading the output

- **Resources section.** Each resource lists its `Kind` and the files or symbols that use it,
  with `(import)` or `(loader)`.
- **File and symbol sections.** A user shows `Uses resource`, with the same mechanism suffix.
- **Unresolved Observations.** A computed loader path is listed with its reason and location.
