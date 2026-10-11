# Event mapping accuracy

Balk2's event mapping is measured against a corpus of realistic mini-repositories whose
connections are written down by hand. The corpus lives in `src/testing/event-corpus.ts` and is
checked by `src/analyzer/event-accuracy.test.ts`.

## What is measured

The exit criterion for event mapping is that **static publishers and subscribers are navigable
through their shared channel**. The corpus measures exactly that, independent of how channels are
named: for every channel, each publisher is paired with each subscriber, and those pairs are
compared with the pairs a developer would say are connected.

- **Pairs found / expected** is recall: how many real connections the map contains.
- **Wrong pairs** is the number of connections the map claims that are not real. A wrong pair
  means two things that never talk to each other were linked, so it is the error that matters most.
- **Observations** checks that the unresolved observations are exactly the ones policy asks for:
  calls that look like events but cannot be resolved are reported, and look-alikes (a Redux
  `dispatch`, a jQuery `on`) are not mistaken for events.
- **Exact edges** checks every relationship, with its channel, owner and direction.

The expected values are written from what the code means, never copied from the tool's output.

## Current results

| Fixture                                                                                   | Pairs found / expected | Wrong pairs | Observations | Exact edges |
| ----------------------------------------------------------------------------------------- | ---------------------- | ----------- | ------------ | ----------- |
| typed emitter app: publish, subscribe, unsubscribe and a cascade                          | 4 / 4                  | 0           | match        | yes         |
| DOM: elements, document and window are separate targets                                   | 3 / 3                  | 0           | match        | yes         |
| composition: an emitter held as a class property, reached through this and an instance    | 2 / 2                  | 0           | match        | yes         |
| untyped JavaScript: a receiver used both ways is an emitter, one that only listens is not | 1 / 1                  | 0           | match        | yes         |
| event names from constants, enums, templates and concatenation                            | 5 / 5                  | 0           | match        | yes         |
| independent systems that all use the event name "ready"                                   | 3 / 3                  | 0           | match        | yes         |
| look-alikes: jQuery-style, Redux-style and other objects that merely share a method name  | 0 / 0                  | 0           | match        | yes         |
| configured protocols: custom methods, a receiver rule, and a disabled built-in            | 1 / 1                  | 0           | match        | yes         |
| listener attribution: named, method, bind, function-valued, inline and parameter          | 5 / 5                  | 0           | match        | yes         |
| listener options: once, capture, passive and abort signals                                | 2 / 2                  | 0           | match        | yes         |
| calls that cannot be resolved are reported, not guessed                                   | 0 / 0                  | 0           | match        | yes         |
| barrels, renames, const aliases and default exports reach the same emitter                | 2 / 2                  | 0           | match        | yes         |
| LIMIT: a class that emits to itself, heard through an instance variable                   | 0 / 1                  | 0           | match        | -           |
| LIMIT: an emitter handed to a function as a parameter                                     | 0 / 1                  | 0           | match        | -           |
| LIMIT: a shared emitter reached through a factory function                                | 0 / 1                  | 0           | match        | -           |

- **Supported conventions:** recall 100% (28/28), precision 100%.
- **Everything, including the known limits:** recall 90% (28/31), precision 100%.

No fixture, including the known limits, links a publisher to a subscriber that does not hear it.

## Known limits

Each limit is a fixture whose expected connection is real, and which the tool does not yet make.
The test pins the exact shortfall, so a regression and an improvement both fail it, and the
corpus is updated deliberately.

1. **A class that emits to itself, heard through an instance variable.** `this.emit('go')` inside
   `class Svc extends Emitter` and `svc.on('go', ...)` on `const svc = new Svc()` get different
   scopes, so they do not share a channel.
2. **An emitter handed to a function as a parameter.** `wire(shared)` where `wire` calls
   `target.on(...)`: the parameter is a different scope from the variable passed in.
3. **A shared emitter reached through a factory function.** `getBus().on(...)` and
   `getBus().emit(...)`: a call result has no identity, so both calls are reported as unresolved
   observations instead of being connected.

In all three the tool reports or omits; it never invents a connection.

## Running it

```
npx vitest run src/analyzer/event-accuracy.test.ts
BALK2_EVENT_REPORT=1 npx vitest run src/analyzer/event-accuracy.test.ts   # also prints the table
```

## Adding a fixture

Add an entry to `EVENT_CORPUS` with the files, the pairs a developer would say are connected, and
the observations policy asks for. A fixture the tool must get exactly right also lists its `edges`.
If the tool falls short of what you wrote, that is either a bug to fix or a limit to document with
`limit: { note, missingPairs, extraPairs }`; do not edit the expectation to match the output.
