# Registry Mapping: What It Finds and How Far to Trust It

The registry pass connects a caller to the class or file it reaches through a string key, such as
`container.get('user')` to the `User` class registered under `'user'`. This page says what that
connection is worth, how it was measured, and where it stops. The configuration itself is in
[registry-protocols.md](registry-protocols.md).

## What a connection means

A connection is drawn only when a lookup and a registration agree on two things: the registry they
belong to, and the key. A lookup in one container never reaches a registration in another, even when
both use the key `'user'`. A lookup whose registry declares other keys, but not this one, while some
other registry declares it, is reported as `ambiguous-registry` with the candidates listed. The pass
never chooses among them.

Three kinds of result are kept apart:

- **Edges** (`registers`, `resolves`, `routesTo`) are the connections the pass is confident in.
- **Observations** (`dynamic-registry-key`, `unknown-registry-receiver`, `ambiguous-registry`) are
  code that looks like a registry but cannot be resolved without guessing. They are listed, never
  drawn as edges.
- **Silence** is the rest: a `get` on a plain object, a `set` on a class with no lookup, a call on
  an `any`-typed receiver. Those are not registries, so they are not reported.

## Measured accuracy

The registry corpus (`src/testing/registry-corpus.ts`) is a set of small repositories with the
connections a developer would name. Expectations were written from the code's meaning before the
tool ran. The accuracy test checks every fixture for exact caller-to-target pairs, exact observations,
and exact edges where a fixture pins them.

| Fixture                                                                             | Pairs found / expected | Wrong pairs | Observations | Exact edges |
| ----------------------------------------------------------------------------------- | ---------------------- | ----------- | ------------ | ----------- |
| container: classes registered on a Map and looked up                                | 2 / 2                  | 0           | match        | yes         |
| two registries share a key name without mixing their targets                        | 2 / 2                  | 0           | match        | -           |
| numeric keys in a Map stay apart from their string form                             | 1 / 1                  | 0           | match        | yes         |
| dictionary literal declares its registrations                                       | 0 / 0                  | 0           | match        | yes         |
| a lookup whose key another registry declares is reported, not connected             | 0 / 0                  | 0           | match        | -           |
| a dynamic key is reported, with no registration invented                            | 0 / 0                  | 0           | match        | -           |
| unrelated receivers are not registries                                              | 0 / 0                  | 0           | match        | yes         |
| a lookup into a registry nobody declares stays silent                               | 0 / 0                  | 0           | match        | -           |
| a manifest supplies a registration the code does not show                           | 1 / 1                  | 0           | match        | yes         |
| a decorator registers a class under its key                                         | 1 / 1                  | 0           | match        | -           |
| files discovered by name are registered, and looked up by name                      | 1 / 1                  | 0           | match        | yes         |
| known limit: a lookup by element access is not mapped yet                           | 0 / 1                  | 0           | match        | -           |
| known limit: a lookup through a parameter is not joined to the registry it receives | 0 / 1                  | 0           | match        | -           |

Supported conventions: recall 100% (8 of 8), precision 100%.
All fixtures, including known limits: recall 80% (8 of 10), precision 100%.

The test enforces three things: perfect recall and precision on supported conventions, no wrong
pairs anywhere (including known limits), and overall recall of at least 70%. Print the table with
`BALK2_REGISTRY_REPORT=1 npx vitest run src/analyzer/registry-accuracy.test.ts`.

The corpus is small. It measures the conventions it contains, not every repository. A fixture
added to the corpus should reflect real code, with its expectation written before the tool is run.

## Known limits

These are real connections the pass does not draw. Each is pinned by a corpus fixture, so a change
in behaviour shows up in the test run.

- **Element-access lookups.** `routes[name]` and `routes['home']` are not lookups. Only method calls
  (`get`, `resolve`, `create`, `load`, `navigate`, and configured methods) and dictionary assignments
  are read.
- **Registries passed as parameters.** `function fetch(m: Map<...>)` cannot be matched to the registry
  a caller passes in, because the parameter's identity is its own. The lookup is silent rather than
  guessed.
- **Keys held in constants.** `const CODE = 404` is not read as a key. A literal or a string
  template is.
- **Object-literal registries without a dictionary type.** `const routes = { home: Home }` is not a
  registry. Declare it as `Record<string, unknown>`, or register it in the manifest.
- **Route declarations.** Plain `{ path, component }` arrays are not registrations. They would need a
  configured source.

## Reading the output

- The **Registries** section gives each key, the registry it belongs to, what it is registered to,
  and which nodes look it up.
- A **connection path** runs `caller → resolves → key → registers → target`. A key with only a
  registration, or only a lookup, produces no path. Turn paths off with
  `pathOptions.includeRegistryKeys: false`.
- Observations appear under **Unresolved Observations**, with their candidates when the problem is
  ambiguity.

## Related

- [registry-protocols.md](registry-protocols.md): configuring methods, decorators, manifests, file
  discovery, and the join rule.
- [connection-map-schema.md](connection-map-schema.md): the registry node and relationship fields.
