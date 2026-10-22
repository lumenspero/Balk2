# Python changes in V3

This records every change in Python output between V2 and V3 that the Phase 0.8 baseline shows.
The regression policy in the V3 plan requires each removed Python edge to be a false positive, and
each new edge to be covered by a corpus fixture or a unit test.

## Baseline changes

The baseline is `test/snapshots/python-baseline.txt`, generated from `test/fixtures/python-baseline`.

| Change | Kind | Justification |
| --- | --- | --- |
| `broken.py:broken` symbol removed | Removed, false positive | `broken.py` contains `def broken(:`, which is not valid Python. The line-based analyzer declared it anyway. The recovering parser skips the broken statement, so no declaration is produced from it. |
| `broken.py -> broken.py:broken [exports]` removed | Removed, false positive | Follows from the symbol removal above. |
| `calls app.py:main -> pipeline/models.py:User.save` added | New, correct | `User().save()` is a method call on a receiver whose type is the constructor's class (5.4c). |
| `calls pipeline/models.py:User.save -> pipeline/util.py:Base.describe` added | New, correct | `self.describe()` inside `User.save` resolves through the MRO of `User`, whose base is `Base` (5.3, 5.4b). |
| `references pipeline/models.py -> pipeline/util.py:Base` added | New, correct | The base class of `User` is named at module level (5.6). |

Every other baseline edge is unchanged, including `app.py:main -> pipeline/models.py:User`,
`pipeline/models.py:User -> pipeline/util.py:Base` (`extends`), and the `helper` calls.

## Behavior changes outside the baseline

These change output for Python code the baseline does not contain. Each is covered by a unit test
in `src/analyzer/python`.

- **Module variables.** Every module-level name is a symbol, not only `UPPER_CASE` constants (decision
  recorded at 5.2). Dataclass and `NamedTuple` fields are `variable` symbols under their class.
- **Nested functions.** A nested function's id is `file:name`, the same rule as a module-level
  function. A nested function can therefore share an id with a module-level symbol of the same
  name. This is a known limit, kept for consistency with the shared owner rule (decision recorded at
  5.7).
- **Recursive calls.** A function that calls itself now has a `calls` edge to itself. The legacy
  analyzer dropped it.
- **Unresolved bases.** A base that names no repository class (for example `Exception`) no longer
  produces an `extends` edge. The legacy analyzer wrote an edge to the base's text, which named no
  graph node.
- **Imports.** Import resolution follows the Phase 4 rules: `from pkg import name` resolves to a
  submodule or an attribute, `if TYPE_CHECKING:` imports are type-only, and namespace packages are
  supported. Only repository files produce `imports` edges, as before.
- **Evidence and spans.** Every edge derived from the fact passes carries `evidence: 'ast'` and its
  span. The canonical text in the snapshot does not print them.
- **Decorators.** Applying a repository decorator emits a `calls` edge with `mechanism: 'decorator'`.
  A call to a function with a non-identity decorator is at most medium confidence (5.5).

## Still on the legacy path

These are not fact passes. They keep their Phase 1 behavior until Phases 11 and 12:

- Data artifact literals (`addDataLiteralsOnLine`).
- `importlib.import_module` loads (`inspectImportModuleCalls`). These still use the legacy path
  resolver.
- Source annotations (`python-source-apply.ts`).
