# Deferred Items

Items the V3 plan does not require for its current phase, which are deferred to a later phase or to a later release. This file is the tracking record. Each entry names the reason and the phase that might reconsider it. No GitHub issues are used.

Decision recorded in Phase 13 review: deferred items are tracked here, not on GitHub.

## Python

- **Subscript write `d[k] = v` is not recorded.** Rare as a shared-state write in the corpora. Reconsider after the Phase 13.3 real-world run shows it matters.
- **A builtin shadowed by a local is not checked.** Rare. Reconsider with the Python shadowing scenarios if a real repository shows a false edge.
- **`files()` through a variable is not followed** (`importlib.resources`). The plan's resource forms use a literal anchor. Reconsider with resources in Phase 14.

## Rust

- **`Library::new` reached through `use libloading::Library` is not read.** The fully qualified form is handled as an observation. Reconsider with the Rust dynamic-load scenarios.
- **Writes inside a `thread_local!` `with` closure are not read.** Reconsider in Phase 14 if a real repository needs it.
- **A configured singleton that matches no static is ignored without a diagnostic.** Reconsider when diagnostics for configuration are reviewed in Phase 15.
- **`lock()` is recorded as a read, without the `access: "lock"` annotation.** The edge is correct, only the annotation is missing. Reconsider in Phase 15 with output.

## Not applicable (out of scope for V3)

- **Field and call-result receivers have no type**, in Python and Rust. Plan section "Explicitly Out of Scope for V3": type inference beyond the local rules in 2.4.

## Scheduled for later phases (not deferred)

- Process execution (matrix row 20): Phase 14.5.
- Cross-language boundaries (matrix row 22): Phase 14.
