# Deferred Items

Items the V3 plan does not require for its current phase, which are deferred to a later phase or to a later release. This file is the tracking record. Each entry names the reason and the phase that might reconsider it. No GitHub issues are used.

Decision recorded in Phase 13 review: deferred items are tracked here, not on GitHub.

Every entry below was approved by the user in Phase 13 review (2026-10-25). Entries marked Not applicable are out of scope for V3 by the plan, not deferred work.

## Python

- **Subscript write `d[k] = v` is not recorded.** Rare as a shared-state write in the corpora. Reconsider after the Phase 13.3 real-world run shows it matters. _Approved in Phase 13 review, 2026-10-25._
- **A builtin shadowed by a local is not checked.** Rare. Reconsider with the Python shadowing scenarios if a real repository shows a false edge. _Approved in Phase 13 review, 2026-10-25._
- **`files()` through a variable is not followed** (`importlib.resources`). The plan's resource forms use a literal anchor. Reconsider with resources in Phase 14. _Approved in Phase 13 review, 2026-10-25._
- **Configured event methods (`protocols.events.methods`) are not read for Python.** V3 keeps configured method protocols to JS/TS. Python event calls are read from the library catalog instead (pyee, blinker, Django signals, `threading.Event`). Reconsider after V3 if a repository has event methods that the catalog cannot name. _Approved in Phase 15 review, 2026-10-26 (option B)._

- **A Python `lib` package whose manifest declares no import roots contributes no root.** Its modules resolve only through configured `python.roots`, a `src/` layout or the repository root. A library outside those places is not found by its import name. Reconsider when a real repository has a `lib` package outside those locations. _Added in Phase 16 review. Approved by the user for 3.0.0._

## Rust

- **`Library::new` reached through `use libloading::Library` is not read.** The fully qualified form is handled as an observation. Reconsider with the Rust dynamic-load scenarios. _Approved in Phase 13 review, 2026-10-25._
- **Writes inside a `thread_local!` `with` closure are not read.** Reconsider in Phase 14 if a real repository needs it. _Approved in Phase 13 review, 2026-10-25._
- **A configured singleton that matches no static is ignored without a diagnostic.** Reconsider when diagnostics for configuration are reviewed in Phase 15. _Approved in Phase 13 review, 2026-10-25._
- **`lock()` is recorded as a read, without the `access: "lock"` annotation.** The edge is correct, only the annotation is missing. Reconsider in Phase 15 with output. _Approved in Phase 13 review, 2026-10-25._

## Not applicable (out of scope for V3)

- **Field and call-result receivers have no type**, in Python and Rust. Plan section "Explicitly Out of Scope for V3": type inference beyond the local rules in 2.4. _Approved in Phase 13 review, 2026-10-25._

## Scheduled for later phases (not deferred)

- Process execution (matrix row 20): Phase 14.5.
- Cross-language boundaries (matrix row 22): Phase 14.
