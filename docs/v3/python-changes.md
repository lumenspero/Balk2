# Python changes in V3

This records every change in Python output between V2 and V3 that the Phase 0.8 baseline shows.
The regression policy in the V3 plan requires each removed Python edge to be a false positive, and
each new edge to be covered by a corpus fixture or a unit test.

## Baseline changes

The baseline is `test/snapshots/python-baseline.txt`, generated from `test/fixtures/python-baseline`.

| Change                                                                       | Kind                    | Justification                                                                                                                                                                                        |
| ---------------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `broken.py:broken` symbol removed                                            | Removed, false positive | `broken.py` contains `def broken(:`, which is not valid Python. The line-based analyzer declared it anyway. The recovering parser skips the broken statement, so no declaration is produced from it. |
| `# syntax`: `broken.py:1:11` and `broken.py:1:12` reported                   | New, correct            | The parser reports the syntax error in `def broken(:` at its line and column (3.3). V2 reported no syntax errors.                                                                                    |
| `broken.py -> broken.py:broken [exports]` removed                            | Removed, false positive | Follows from the symbol removal above.                                                                                                                                                               |
| `calls app.py:main -> pipeline/models.py:User.save` added                    | New, correct            | `User().save()` is a method call on a receiver whose type is the constructor's class (5.4c).                                                                                                         |
| `calls pipeline/models.py:User.save -> pipeline/util.py:Base.describe` added | New, correct            | `self.describe()` inside `User.save` resolves through the MRO of `User`, whose base is `Base` (5.3, 5.4b).                                                                                           |
| `references pipeline/models.py -> pipeline/util.py:Base` added               | New, correct            | The base class of `User` is named at module level (5.6).                                                                                                                                             |

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
- **`PythonAnalyzer.analyzeFile` (deprecated).** The single-file API now writes the fact-based
  output. `extends` targets are node ids (`file:Base`) where V2 wrote the base's text.
- **Decorator sources.** A decorator call starts at the decorated function, method or class.
- **Conditional imports.** A name imported in several branches calls each target, at medium confidence.
- **Decorators.** Applying a repository decorator emits a `calls` edge with `mechanism: 'decorator'`.
  A call to a function with a non-identity decorator is at most medium confidence (5.5).
- **Straight-line `del`.** A `del` that runs directly in a module, class or function body unbinds
  the name for later uses in that body, until it is bound again. Before, a name stayed bound after
  `del`. A `del` in a branch or loop, and uses in nested functions, still leave the name bound.
- **Configuration.** `python.identityDecorators` adds to the identity-decorator list, and
  `python.roots` sets the import roots in precedence order. Without `python.roots`, the repository
  root is the only root.
- **Import roots not yet read.** Manifest roots and the `src/` layout (Phase 4.2) are deferred. The
  repository root is the only default root.

## Still on the legacy path

These are not fact passes. They keep their Phase 1 behavior until Phases 11 and 12:

- Data artifact literals (`addDataLiteralsOnLine`).
- `importlib.import_module` loads (`inspectImportModuleCalls`). These still use the legacy path
  resolver.
- Source annotations (`python-source-apply.ts`).

## Package facts (V3 Phase 7.5 wiring)

These come from the manifests in `pyproject.toml` projects. Each is new output. No existing Python edge changed or was removed.

- **Package nodes.** Each project is a `lib` package node. Each `[project.scripts]` entry is a `script` node.
- **`packageRoot`.** A script node points at the module it runs, when the module resolves.
- **`dependsOn`.** A path or uv workspace dependency on another project in the repository. Its `kind` is kept in metadata.
- **uv workspace membership.** A `workspace = true` source to a project outside the enclosing workspace's `members`, or inside its `exclude`, draws no edge and reports a `manifest` problem. Removed edge: uv rejects such a source, so the edge described a dependency uv does not accept. A project with no enclosing uv workspace is unchanged.
- **`registers`.** An entry point in a `[project.entry-points."group"]` table points from its `registry:entry-points:<group>#<name>` key to its target symbol or file.
- **Baseline.** `python-baseline` has no manifest, so `python-baseline.txt` is unchanged.

## Phase 11.2 output change (Python data lineage)

- A call whose callee resolves to a library API in the Python data catalog (`src/facts/data-catalog.ts`, `PYTHON_DATA_APIS`), with a plain string literal in the artifact's argument position, now sets the direction of the artifact at `high` confidence. The resolver is in `src/analyzer/python/data-apis.ts`.
- Covered: `open` (its mode decides the direction), `pandas` and `polars` readers, `duckdb` readers, `pyarrow.parquet` `read_table`/`write_table`, `numpy` `load`/`save` families, `shutil.copy`/`copy2`/`copyfile` (source read, destination write), and `sqlite3.connect` (`reads`).
- The callee is resolved through the scope tracker and the module's imports. A repository function, a local variable, or an unimported module with the same name is not matched.
- A literal the catalog claims is skipped by the line-based pass, so it gets one edge, from the catalog. The keyword rule still covers every other literal.
- Direction changes in Python output are expected where the keyword rule guessed. Examples: `np.savetxt('out.csv', ...)` gives `generates` (was a low-confidence `reads`), and `sqlite3.connect('x.sqlite')` gives `reads` at high confidence (was a low-confidence guess). Each is covered by `src/analyzer/python-data-apis.test.ts`.
- Bare paths are placed by the 11.4 rule, from the script's directory and then the repository root.
- Not in 11.2: receivers. Methods on a `pandas.DataFrame`, `pathlib.Path` variables, `csv`, `json`, `pickle`, `yaml` and `tomllib` loads and dumps on file handles, and `Final` constants (Phase 11.5 for Python). Those keep the keyword rule until typed receivers and handle flows land.

## Phase 11.5 output change (Python constants)

A module-level constant whose name is upper-case and bound exactly once to a plain string literal now carries its value to catalog calls in the same file or to calls that import it by name (`from .cfg import DB`). `sqlite3.connect(DB)` therefore yields a `reads` edge at high confidence from the calling file to the artifact. The artifact is placed from the file that declares the constant, under the 11.4 rule. Constants with a `Final` annotation are accepted. A name bound twice, a lower-case name, or a non-literal value is not treated as a constant.

The line-based keyword pass places its bare literals by the same 11.4 rule, from the file's directory, then the repository root. A literal such as `'cfg.json'` on a line with no catalog call now gives its low-confidence edge to `lib/cfg.json` when that file exists beside the caller, where it used to go to the root. This is a baseline change for Python: a bare literal next to an existing file of the same name is now placed beside its caller.

Handle flows (`json.load(f)`, `pickle.load`, and similar) add no edges of their own. The artifact path is set at the `open` call, which the catalog already matches.

## Phase 11.6 output change (Python method receivers)

A method call on a value of known type gives a data edge at high confidence:
- `Path(p).read_text()`, `read_bytes()`, `write_text()`, `write_bytes()`, and `Path(p).open(mode)` take the path the `Path` holds. A `Path` assigned to a name once in its scope is typed from that assignment, so `store = Path('data/cfg.json')` followed by `store.read_text()` reads it. A name assigned twice is not typed.
- `df = pd.read_csv(...)` followed by `df.to_csv`, `to_parquet`, `to_json`, `to_excel` or `to_feather` writes the destination. The DataFrame is typed the same way: a single assignment from a pandas reader.

A method on any other value is not a catalog call. `open` on a `Path` writes when its mode writes, as the builtin does.
