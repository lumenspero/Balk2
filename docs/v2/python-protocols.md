# Python protocols

The Python analyzer covers a small set of mechanisms. It is line-based and regex-driven, not
type-checked, so each mechanism below is recognised for the forms shown and no others. Treat this as
coverage for these mechanisms, not as parity with the JavaScript and TypeScript analysis.

## Imports

`import pkg.util`, `import pkg.util as u`, `from pkg.util import help` and relative imports
(`from .util import help`) produce `imports` edges to a file in the repository. Modules are resolved
against the scanned files: `pkg/util.py` and `pkg/util/__init__.py` both count. A module that is not
in the repository produces no edge.

## Dynamic module loads (`importlib`)

`importlib.import_module` is recorded when the module name is a string literal:

```python
import importlib

def load():
    return importlib.import_module('pkg.util')
```

This adds an `imports` edge from the enclosing function to `pkg/util.py`, with
`metadata.loadKind: "import-module"`. A bare `import_module(...)` is recognised only when it was
bound by a from-import (`from importlib import import_module`), so an unrelated local function of the
same name is ignored.

A module name that is not a string literal, such as `importlib.import_module(name)`, produces a
`dynamic-module-specifier` observation linked from the owner at low confidence. The observation's
location is the line of the call. A literal naming a module outside the repository is silent.

## Calls

Calls to functions and classes defined in the same file, and to names imported from repository
modules, produce `calls` edges from the enclosing function or method. Methods are named
`file:Class.method`.

## Source annotations

Python source directives use `#` comments with the same grammar as TypeScript and JavaScript:

```python
def run():
    # balk2: confidence=low app.py:run calls pkg/util.py:help
    return help()
```

The rules match the JavaScript form:

- The directive must sit directly above the statement it annotates. A blank line or another comment
  between them is reported as a problem.
- Its `from` must be the enclosing owner, the function or `Class.method` that contains the statement,
  or the file at top level. A different owner is reported and ignored.
- A directive inside a triple-quoted string (a docstring, for example) is text, not a directive.
- A source directive overrides a `.balk2.json` annotation for the same edge.

## Not applicable in Python

- **`Reflect` metadata** (`protocols.metadata`) is a TypeScript mechanism and is not read from Python.
- **Template and stylesheet imports** (`protocols.resources`, `usesResource`) are not read from Python.
- **Registries, callbacks, events and state** are JavaScript and TypeScript analyses. They are not
  applied to Python files.

## Limits

- The analyzer reads one line at a time. A call or `importlib` call split across several lines is not
  recognised.
- Names are matched textually. An alias that is rebound (`imp = importlib.import_module`) is not
  followed.
- Owners follow indentation: `def` and `class` lines at column 0 reset the owner, and nested
  functions keep the enclosing owner.
- A `#` directive is read only from a line that starts with `#` after whitespace. A trailing comment
  on a code line is not a directive.
