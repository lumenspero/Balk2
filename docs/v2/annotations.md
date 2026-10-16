# Annotations

An annotation is a project decision about an existing relationship. It sets the confidence of one
edge the analysis already found, and records that a person decided it. Annotations are the way to
say "this call is real, treat it as high confidence" or "this link is only a guess, mark it low"
without changing the code the detectors read.

Annotations never create a relationship. A manual fact that adds an edge would bypass the detectors,
so an annotation that names an edge the analysis did not find is reported and ignored.

## Two places to write them

Annotations come from two sources. Both name the edge the same way: by its type, source and target.

- **`.balk2.json`**, under a top-level `annotations` array. Useful for decisions about a whole
  project, or for an edge in a file you do not want to edit.
- **Source comments**, written as `// balk2: confidence=<level> <from> <type> <to>` directly above the
  statement they annotate. Useful when the decision belongs next to the code it describes.

Where both name the same edge, the **source comment wins**, and the config entry is reported as
ignored.

### In `.balk2.json`

```json
{
  "annotations": [
    { "type": "calls", "from": "src/main.ts:run", "to": "src/util.ts:help", "confidence": "low" }
  ]
}
```

| Field        | Meaning                                                                           |
| ------------ | --------------------------------------------------------------------------------- |
| `type`       | The relationship type, for example `calls`, `imports` or `registers`              |
| `from`       | The source of the edge, as the map shows it (a symbol id or a file path)          |
| `to`         | The target of the edge, as the map shows it                                       |
| `confidence` | `high`, `medium` or `low`. Required; an annotation with no confidence is rejected |

All four fields are required. An unknown field is reported and ignored.

### In source

```ts
export function run(): number {
  // balk2: confidence=low src/main.ts:run calls src/util.ts:help
  return help();
}
```

The form is `balk2: confidence=<level> <from> <type> <to>`, separated by single spaces. Symbol ids
and file paths contain no spaces, so the directive splits cleanly.

Placement rules:

- The directive must be a `//` line comment. Block comments and text inside strings are never read.
- It must sit **directly above** the statement it annotates. A blank line between the directive and
  the statement is reported as a problem.
- Its `from` must be the **enclosing owner** of that statement: the function or method that contains
  it, or the file itself at top level. A directive that names a different owner is reported and
  ignored, so a comment cannot annotate an edge elsewhere in the file.

A directive inside a class method names the method (`src/main.ts:Service.run`), not the class. A
directive inside a nested block names the enclosing function.

### In Python

Python files use the same directive with a `#` comment. The rules are the same: directly above the
statement, the owner must match, and a directive inside a triple-quoted string is ignored. See
`python-protocols.md` for the Python coverage and its limits.

## What an annotation changes

An applied annotation sets three things on the edge:

- `confidence` becomes the level it names. This can raise or lower it.
- `evidence` becomes `config`, because the decision came from the project and not the detector.
- `metadata.annotated` becomes `true`.

The detector's original evidence is replaced. This is a visible change to the output: an annotated
edge no longer shows `ast` or `ts-program`, and the map reads `config` for it. Consumers that filter
on evidence should treat `config` as "decided by the project."

An annotation never changes an edge that points to an unresolved observation. A diagnostic is not a
relationship, and changing its link would hide or invent a finding. The annotation is reported as
ignored instead.

## Problems

Every annotation that is not applied produces a problem, printed with the other configuration
warnings during `generate` and `check`. Problems have a path that says where the annotation was
written: `annotations[i]` for `.balk2.json`, and `file:line` for a source comment.

| Problem                                                       | Cause                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------- |
| no `<type>` relationship from `<from>` to `<to>`              | the edge is not in the map; check both names                  |
| `<type>` to `<id>` is an unresolved observation               | the target is a diagnostic, not a relationship                |
| source annotation from X does not match the enclosing owner Y | the directive names a different owner than the one it sits in |
| directive must sit directly above the statement               | a blank line or another line separates them                   |
| is set in a source comment; the config annotation is ignored  | the same edge has both; the source comment wins               |

## Reading the output

- An annotated edge shows its confidence in the markdown, as with any reduced-confidence edge:
  `(low confidence)` or `(medium confidence)`.
- In the JSON, the edge has `evidence: "config"` and `metadata: { "annotated": true }`.
