# Python

This is the reference for how Balk2 analyzes Python in V3: which forms it recognizes, how names
resolve, which mechanisms it detects, and what it does not do. It replaces
`docs/v2/python-protocols.md`. Changes from V2 are listed in `docs/v3/python-changes.md`.

## Recognized forms

### Imports

- `import a.b`, `import a.b as x`, `from a.b import c`, and relative imports (`from .util import x`).
- `from pkg import name` resolves `name` to a submodule when one exists, and otherwise to an
  attribute of `pkg`.
- `if TYPE_CHECKING:` imports are type-only. They are still edges, with the type-only flag set.
- `try` and `except` alternatives carry their branch as a condition. Both branches are analyzed.
- Namespace packages (directories without `__init__.py`) are modules.
- Only imports of repository files produce `imports` edges. External modules produce none.

### Symbols

- Classes, functions, and methods. A method's id is `file:Class.method`, and nested classes are
  `file:Outer.Inner`.
- Module-level names. Every module-level name is a `variable` symbol, and `UPPER_CASE` or `Final`
  names are `constant`.
- Dataclass and `NamedTuple` fields are `variable` symbols under their class.
- A name starting with `_` is private. Exports come from `__all__` when it is a static list, and
  otherwise from the public names.

### Inheritance

- `extends` runs from a class to each base that is a repository class. Bases are merged by C3 over
  the repository's classes. A class with no consistent MRO gets no MRO-based calls, though its
  `extends` edges are still written.
- `implements` runs from a class to an abstract base when the class is registered with
  `Base.register(Cls)`.
- A class is abstract when it derives from `typing.Protocol`, `abc.ABC`, or uses `abc.ABCMeta` as its
  metaclass, directly or transitively.

### Calls

A `calls` edge runs from the enclosing function or method (or from the file, for module-level code)
to the callee:

- A name bound at module level, including `from x import f`.
- `module.f()` for a repository module bound by `import`.
- `Class.method()`, and `Outer.Inner()` for nested classes.
- `Class()` is a `construct` edge to the class, and also a `calls` edge to `Class.__init__` when the
  class defines one.
- `self.m()` and `cls.m()` in a method resolve through the class's MRO. The receiver must be the
  method's first parameter, and the method must not be a `@staticmethod`.
- `super().m()` (zero-argument form) resolves to the first `m` after the enclosing class in its MRO.
- A receiver with a type from the local-type rules: an annotated parameter or variable, a name bound
  only to one class's constructor, or a call whose return annotation names a class (medium
  confidence). `Optional[C]` and `C | None` are peeled to `C`.
- `functools.partial(f)(...)`, a name bound only to `functools.partial(f)`, and `f.__call__()` for a
  repository function `f`.
- Decorators. Applying a repository decorator emits a `calls` edge with `mechanism: 'decorator'`,
  from the decorated function, method or class. Calls to a function or class with a decorator that is not an identity
  decorator are at most medium confidence.

Identity decorators are those that return their argument unchanged: `property`, `staticmethod`,
`classmethod`, `functools.wraps`, `functools.cache`, `functools.lru_cache`, `dataclasses.dataclass`,
and `contextlib.contextmanager`. Further identity decorators can be listed in `.balk2.json`, under
`python.identityDecorators`, as the names they are written with.

Import roots can be set under `python.roots`, in precedence order, as repository-relative paths. Without it, the repository root is the only root. Manifest roots and the `src/` layout (Phase 4.2) are not yet read.

### References

A `references` edge runs from the scope a name is evaluated in to a repository class, for:

- Parameter, return and annotated-assignment annotations, including names inside subscripts and
  unions.
- String forward references in annotations, parsed as expressions.
- Base classes.
- The second argument of `isinstance` and `issubclass`, including tuples.
- `except` classes, including tuples.
- Class patterns in `match` statements.

A dataclass or `NamedTuple` field annotation is owned by the field, not the class. `Literal[...]`
strings are values, not types. Only the first argument of `Annotated` is a type.

## Resolution rules

- Names resolve with the LEGB rules. A class scope is skipped when resolving names inside its
  methods. Comprehensions have their own scope. `global` and `nonlocal` are honored, and `:=` binds in
  the nearest enclosing non-comprehension scope.
- Builtins resolve last, after module scope. A name bound by a `from x import *` is ambiguous when it
  could come from more than one module, and it is unresolved.
- A local type is used only when the name has one binding. A rebinding to a different class drops
  the type. A rebinding to the same class keeps it.
- Conditional definitions (`try`/`except` or `if` twins) keep one symbol, and their bases are merged.
- A name imported in several branches (a `try`/`except ImportError` fallback) counts every branch. A
  call through it goes to each target, at medium confidence, since only one of them runs.

## Mechanisms

These are not yet produced by the fact passes. They keep their V2 behavior until Phases 11 and 12.

- **Data artifact literals.** A path literal that names a data file (`open('out/x.json', 'w')`,
  `self.dir / 'x.json'`) produces a `generates`, `consumes` or `reads` edge, with high confidence
  when the access mode is certain.
- **`importlib.import_module`.** A string literal naming a repository module produces an `imports`
  edge from the owner, with `metadata.loadKind: "import-module"`. A computed name produces a
  `dynamic-module-specifier` observation at low confidence. A bare `import_module` is recognized only
  when a from-import bound it.
- **Source annotations.** A `# balk2:` comment directly above a statement can set the confidence or
  add an edge. It must name the enclosing owner. A directive inside a triple-quoted string is text.

## Shared state

- A module global that a function writes through `global name` is shared state, at `<file>:name`.
- With `import mod`, `mod.name = ...` in a function writes `<mod file>:name`.
- `builtins.x = ...` writes the global root, as `globalThis` does in JS.
- A configured singleton is read through its fields. With `from store import store`, the write
  `store.count = 1` in a function writes the singleton at field `count`, and `store.a.b = 1` writes
  `a.b`. The entry is matched by module and export:

```json
{ "state": { "singletons": [{ "module": "store.py", "export": "store" }] } }
```

The limits of shared-state recording are listed in `docs/v3/language-parity.md`.

## Limits

- `del` is straight-line only. A `del` that runs directly in a module, class or function body unbinds the name for later uses in that body, until it is bound again. A `del` in a branch or loop, and uses in nested functions, leave the name bound.
- `except E as name` does not unbind `name` after the handler.
- An annotation without a value counts as a local binding.
- A class defined inside a function is not resolved by name from outside that function.
- Names inside a string forward reference resolve only at module level, not in a class or function
  scope. Dotted names inside strings are not resolved.
- `self.x` attributes are not typed. A chained call such as `a.b().c()` is not typed.
- The two-argument `super(C, self)` form is not resolved.
- Star imports make a name unresolved when more than one module could supply it.
- Abstractness is transitive.
- A nested function's id is `file:name`, the same form as a module-level function. A nested function
  can share an id with a module-level symbol of the same name.
- Decorators are not expanded. Only the identity list is treated as returning the decorated symbol
  unchanged.
- Type inference stops at the local-type rules. There is no flow narrowing, no generic inference, and
  no type checker run at generate time.
- A syntax error is reported as a syntax diagnostic at its line and column, and the parser recovers
  past it, so the rest of the file is still analyzed.
- `PythonAnalyzer.analyzeFile` analyzes one file. Facts that depend on another file's contents are
  missing unless that file is passed in or readable under `rootDir`. Use `PythonFrontEnd` for a
  repository. `PythonAnalyzer` is deprecated.

## Not applicable in Python

- **`Reflect` metadata.** Python has no runtime metadata API keyed by strings. Decorators are covered
  by the decorator rules above and by registries (Phase 12).
- **JavaScript global-object traversal.** Python's equivalent is `builtins`, covered under shared
  state (Phase 12).
- **Template and stylesheet imports.** These are not read from Python source.

For the status of each mechanism family across languages, see `docs/v3/language-parity.md`.

## Registries: pytest fixtures (recipe)

Parameter-name injection is configured, not built in. A repository that uses pytest fixtures
declares them as a registry and injects them into test parameters by name:

```json
{
  "protocols": {
    "registries": {
      "nameInjection": [{ "registry": "fixtures", "decorator": "pytest.fixture" }]
    }
  }
}
```

A function decorated with `@pytest.fixture` is declared in the `fixtures` registry under its own
name. A function parameter named after a declared fixture injects it, and a parameter that names
no declared fixture adds no edge. The decorator is matched as written, so `pytest.fixture` matches
`@pytest.fixture` and `@pytest.fixture(scope=...)`, but not `@fixture` after
`from pytest import fixture`. The rule applies to Python only. The JavaScript and TypeScript
front end ignores `nameInjection`.

## Registries: decorator attributes (recipe)

A decorator can register the item it sits on, configured under `protocols.registries.attributes`:

```json
{
  "protocols": {
    "registries": {
      "attributes": [
        { "name": "route", "key": "fn-name", "registry": "commands" },
        { "name": "route", "key": { "arg": 0 }, "registry": "routes" }
      ]
    }
  }
}
```

`fn-name` declares the decorated function or class under its own name. `{ "arg": n }` declares it
under the string or number literal in the decorator call's argument at that position, so
`@route('/x')` declares `/x`. A bare decorator such as `@route` has no argument, so only `fn-name`
applies to it. A decorator matches by its name as written, and only symbols declared in the
repository are declared. The same form applies to Rust attributes on free functions and type declarations. Methods in an
`impl` or `trait` are not read.

## Registries: route decorators and bare calls (recipe)

A route decorator declares the path it serves, and a configured method looks the path up. Both use
the registry named in the configuration, so the lookup emits `routesTo` to the decorated function:

```json
{
  "protocols": {
    "registries": {
      "attributes": [{ "name": "app.route", "key": { "arg": 0 }, "registry": "routes" }],
      "methods": [{ "method": "navigate", "direction": "route", "keyArg": 0, "registry": "routes" }]
    }
  }
}
```

```python
@app.route('/users')
def users():
    return []

def go():
    return navigate('/users')   # routesTo the /users key, which declares users
```

A method with a `registry` is matched only as a bare call (`navigate(...)`), never as a method on a
receiver (`page.navigate(...)`), so a method of a common name cannot connect by accident. The
decorator name is matched as written, so `app.route` matches `@app.route(...)` but not `@route(...)`.
The Python lookup is a bare call of a name the configuration lists; it does not infer the route
framework's own client calls.
