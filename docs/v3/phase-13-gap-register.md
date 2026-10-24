# Phase 13 Gap Register

Status of each gap from the 13.1 table. Each gap ends as **Fixed** (a scenario now passes), **Not applicable** (with a semantic reason), **Deferred** (approved, with a tracking issue), or **Open** (still needs a fix or a decision). Pending renditions in `src/testing/parity-corpus.ts` and `python-corpus.ts` name the phase that clears them.

## Budgets (13.2)

Enforced in `src/analyzer/parity-accuracy.test.ts`, for every language, over non-pending renditions: recall 100% and zero declared false positives. Met for JavaScript, Python and Rust.

Not yet measured: the performance budget on synthetic repositories (1,000 files, about 150k lines, plan 0.7).

## Label renames (fixed)

- Rust `modules` and Python `modules and imports` are now `modules and imports`.
- Python `syntax` is now `lexing`, matching Rust. The Python scenarios with that label check that valid code parses, not that errors are reported, so `syntax` was misleading. `syntax diagnostics` is unchanged.

## Coverage gaps

| Matrix row                   | Status                 | Notes                                                                                                                                                                                                                                                           |
| ---------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9 Type references            | Open (JS/TS)           | Python and Rust scenarios pass. JS/TS does not produce a `references` edge from a signature to an imported class or interface, although the matrix says Supported. Pending `13`. Python annotations belong to the module, because they run when the `def` runs. |
| 17 Resources                 | Open (JS/TS)           | Python and Rust pass. The JS/TS form is undecided: `readFileSync` of a file is a data read, not a resource. Needs a decision on the form before a scenario can be written. Pending `13`.                                                                        |
| 21 Packages                  | Open (Python)          | JS/TS and Rust pass. Python discovers the project but emits no `packageRoot` edge when the manifest declares no roots, because plan 4.2 root inference is not applied to packages. Needs a decision on what `packageRoot` targets in Python. Pending `13`.      |
| 16 Dynamic module loads      | Open (Rust)            | JS/TS and Python pass. A literal `libloading::Library::new` is reported as `unresolved-module-path`, not as an observation as plan 12.5 requires. Needs a decision on the observation reason. Pending `13`.                                                     |
| 23 Source annotations        | Fixed                  | All three languages pass. Expectations can now check confidence. Annotations sit inside the owner's body in every language, as the Rust tests already did.                                                                                                      |
| 25 Test code tagging (D5)    | Open, needs a decision | There is no representation for test code. `FileNode` has no metadata field, so nothing can be tagged. No scenario is written yet. Needs a decision on where the tag lives.                                                                                      |
| 20 Process execution         | Out of scope           | Phase 14.5.                                                                                                                                                                                                                                                     |
| 22 Cross-language boundaries | Out of scope           | Phase 14.                                                                                                                                                                                                                                                       |

## Phase 12 known limits

- **Python: a function-local name shadows an import.** Fixed: three shadowing negatives (JS/TS, Python, Rust) pass.
- **Python: a `lambda` callback is unresolved.** Fixed as a reported observation: the lambda is reported as `unresolved-callback`, and the calls inside it are kept. A named lambda symbol is not created, which matches the plan's rule that dynamic constructs are reported, not guessed. Scenario in `python-corpus.ts`.
- **Python: a builtin shadowed by a local is not checked; `files()` through a variable is not followed; a subscript write `d[k] = v` is not recorded.** Deferred, rare forms. Tracking issue: not yet created.
- **Rust: `Library::new` through `use libloading::Library` is not read; writes inside a `thread_local!` `with` closure are not read; a configured singleton that matches no static is ignored without a diagnostic; `lock()` is recorded as a read without the `access: "lock"` annotation.** Deferred, rare forms. Tracking issue: not yet created.
- **Python and Rust: field and call-result receivers have no type.** Not applicable. Plan section "Out of Scope": type inference beyond the local rules.

## Decisions still needed

1. Test-code tagging (row 25): where the tag lives. Options: a new `FileNode` field, or metadata on the file node.
2. JS/TS resource form (row 17): which JS/TS construct is a resource.
3. Python package root target (row 21): whether `packageRoot` points at the `__init__.py` file or the package directory.
4. Rust observation reason (row 16): the reason name for a literal `libloading` path.
5. Create GitHub tracking issues for the Deferred items. I have not created any.
