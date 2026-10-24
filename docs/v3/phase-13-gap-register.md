# Phase 13 Gap Register

Status of each gap from the 13.1 table. Each gap ends as **Fixed** (a scenario now passes), **Not applicable** (with a semantic reason), **Deferred** (approved, with a tracking issue), or **Open** (still needs a fix or a decision). Pending renditions in `src/testing/parity-corpus.ts` and `python-corpus.ts` name the phase that clears them.

## Budgets (13.2)

Enforced in `src/analyzer/parity-accuracy.test.ts`, for every language, over non-pending renditions: recall 100% and zero declared false positives. Met for JavaScript, Python and Rust.

Not yet measured: the performance budget on synthetic repositories (1,000 files, about 150k lines, plan 0.7).

## Label renames (fixed)

- Rust `modules` and Python `modules and imports` are now `modules and imports`.
- Python `syntax` is now `lexing`, matching Rust. The Python scenarios with that label check that valid code parses, not that errors are reported, so `syntax` was misleading. `syntax diagnostics` is unchanged.

## Coverage gaps

| Matrix row                   | Status                 | Notes                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9 Type references            | Fixed                  | JS/TS now emits `references` from a function, class or file to a repository class, interface, type alias or enum named in a type position. Python annotations are owned by the module, because they run when the `def` runs. Scenario passes in all three languages.                                                                                        |
| 21 Packages                  | Fixed                  | Python libraries now emit `packageRoot` to each top-level package's `__init__.py` or top-level module, in each declared root. With no declared root, `src` is used when the repository has Python under it, and the repository root otherwise (plan 4.2). Test packages and `setup.py`, `conftest.py` are excluded. Scenario passes in all three languages. |
| 23 Source annotations        | Fixed                  | All three languages pass. Expectations can check confidence. Annotations sit inside the owner's body in every language.                                                                                                                                                                                                                                     |
| 17 Resources                 | Open (JS/TS)           | Python and Rust pass. The JS/TS form is undecided: `readFileSync` of a file is a data read, not a resource. Pending `13`.                                                                                                                                                                                                                                   |
| 16 Dynamic module loads      | Open (Rust)            | JS/TS and Python pass. A literal `libloading::Library::new` is reported as `unresolved-module-path`, not as an observation as plan 12.5 requires. Pending `13`.                                                                                                                                                                                             |
| 25 Test code tagging (D5)    | Open, needs a decision | There is no representation for test code. `FileNode` has no metadata field, so nothing can be tagged. No scenario is written.                                                                                                                                                                                                                               |
| 20 Process execution         | Out of scope           | Phase 14.5.                                                                                                                                                                                                                                                                                                                                                 |
| 22 Cross-language boundaries | Out of scope           | Phase 14.                                                                                                                                                                                                                                                                                                                                                   |

## Release notes (engine changes in Phase 13)

- JS/TS now emits `references` for type positions that name a repository type. Existing JS/TS snapshots did not change. One existing test was narrowed: the constructor parameter of a class now has a `references` edge, so the injection test checks only non-reference edges.
- Python libraries now emit `packageRoot` edges to their entry files. These are new output for every Python library with a manifest.

## Phase 12 known limits

- **Python: a function-local name shadows an import.** Fixed: three shadowing negatives (JS/TS, Python, Rust) pass.
- **Python: a `lambda` callback is unresolved.** Fixed as a reported observation: the lambda is reported as `unresolved-callback`, and the calls inside it are kept. A named lambda symbol is not created, which matches the plan's rule that dynamic constructs are reported, not guessed. Scenario in `python-corpus.ts`.
- **Python: a builtin shadowed by a local is not checked; `files()` through a variable is not followed; a subscript write `d[k] = v` is not recorded.** Deferred, rare forms. Tracking issue: not yet created.
- **Rust: `Library::new` through `use libloading::Library` is not read; writes inside a `thread_local!` `with` closure are not read; a configured singleton that matches no static is ignored without a diagnostic; `lock()` is recorded as a read without the `access: "lock"` annotation.** Deferred, rare forms. Tracking issue: not yet created.
- **Python and Rust: field and call-result receivers have no type.** Not applicable. Plan section "Out of Scope": type inference beyond the local rules.

## Decisions still needed

1. Test-code tagging (row 25): where the tag lives. Options: a new `FileNode` field, or metadata on the file node.
2. JS/TS resource form (row 17): which JS/TS construct is a resource.
3. Rust observation reason (row 16): the reason name for a literal `libloading` path.
4. Create GitHub tracking issues for the Deferred items. I have not created any.
5. Python `packageRoot` target: I chose the top-level package's `__init__.py` (or top-level module). Confirm, or name the alternative.
