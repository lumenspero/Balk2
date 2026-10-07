# Event protocols

Balk2 maps event-driven code through virtual event-channel nodes: a publisher links to the channel
with `emits` or `dispatches`, a listener links to it with `subscribes` or `unsubscribes`. A
**protocol** describes how one method call maps onto a channel.

## Built-in protocols

The built-in catalog is deliberately small. Distinctive names are trusted outright; generic names
need evidence that the receiver really is an event emitter or target.

| Method                | Direction     | Event argument   | Other arguments               | Receiver     |
| --------------------- | ------------- | ---------------- | ----------------------------- | ------------ |
| `addEventListener`    | `subscribe`   | 0                | listener 1, options 2         | `any`        |
| `removeEventListener` | `unsubscribe` | 0                | listener 1, options 2         | `any`        |
| `dispatchEvent`       | `dispatch`    | 0 (event object) |                               | `any`        |
| `on`                  | `subscribe`   | 0                | listener 1                    | `event-like` |
| `once`                | `subscribe`   | 0                | listener 1, one-time listener | `event-like` |
| `off`                 | `unsubscribe` | 0                | listener 1                    | `event-like` |
| `emit`                | `emit`        | 0                | payload 1                     | `event-like` |
| `dispatch`            | `dispatch`    | 0                | payload 1                     | `event-like` |

An _event object_ argument is a constructed event such as `new Event('ready')` or
`new CustomEvent('ready', { detail })`; the name is read from its constructor.

## Receiver rules

| Rule                                 | Meaning                                                                                                                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"any"`                              | The method name alone is enough.                                                                                                                                                                                                            |
| `"event-like"`                       | The receiver's type declares at least one subscribe method and at least one emit or dispatch method from the active catalog. `EventEmitter`, `EventTarget` and `mitt` qualify; a Redux store (no subscribe method in the catalog) does not. |
| `{ "names": [...], "types": [...] }` | The receiver expression's last name is in `names`, or its type's name is in `types`.                                                                                                                                                        |

A call whose receiver cannot be shown to qualify is reported as an unresolved observation; it is
never connected to every other use of the same string.

## Configuration

Add project conventions under `protocols.events` in `.balk2.json`, without changing Balk2 itself:

```json
{
  "protocols": {
    "events": {
      "builtIns": true,
      "disable": ["dispatch"],
      "methods": [
        {
          "method": "publish",
          "direction": "emit",
          "eventArg": 0,
          "payloadArg": 1,
          "receiver": { "types": ["PubSub"] }
        },
        {
          "method": "subscribe",
          "direction": "subscribe",
          "eventArg": 0,
          "listenerArg": 1,
          "optionsArg": 2
        }
      ]
    }
  }
}
```

| Field                                 | Meaning                                                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `builtIns`                            | Use the built-in catalog (default `true`).                                                                |
| `disable`                             | Built-in methods to switch off.                                                                           |
| `methods[].method`                    | Method name matched on a receiver.                                                                        |
| `methods[].direction`                 | `subscribe`, `unsubscribe`, `emit` or `dispatch`.                                                         |
| `methods[].eventArg`                  | Zero-based index of the event name (or event object).                                                     |
| `methods[].eventArgKind`              | `name` (default) or `event-object`; `emit` and `dispatch` only.                                           |
| `methods[].payloadArg`                | Payload index; `emit` and `dispatch` only.                                                                |
| `methods[].listenerArg`, `optionsArg` | Listener and options indexes; `subscribe` and `unsubscribe` only.                                         |
| `methods[].once`                      | The listener runs at most once; `subscribe` only.                                                         |
| `methods[].receiver`                  | A receiver rule. Defaults to `"any"` for configured methods: naming a method states the intent to map it. |

At most one protocol exists per method name. A configured method replaces the built-in of the same
name, and a second configured entry for the same name is ignored. Argument indexes are 0 to 15 and
must be distinct within one entry.

## How names are read

The event argument is resolved statically, in this order:

1. A string literal or a template without substitutions.
2. A template or `+` concatenation whose parts are all static (`` `user:${KIND}` ``, `'a' + ':' + 'b'`).
3. A reference to a **constant**: a `const` binding (including one imported from another file), a
   property of a constant object (`EVENTS.READY`, `EVENTS['READY']`, nested objects), a string enum
   member, or a `static readonly` class property.
4. A value whose declared type is a single string literal (`declare const X: 'ready'`, or a
   parameter typed `'ready'`).

Anything else is **dynamic**: a `let` binding, a call result, a string-typed parameter, a union of
literals. A dynamic name on a recognized protocol call becomes an unresolved observation. An
argument that cannot be a name at all (an object such as a Redux action, a number, a function) is
not an event call and is skipped without a note.

`dispatchEvent(event)` reads the name from the constructed event: `new Event('x')`,
`new CustomEvent('x', ...)` or any `Event` subclass, directly or through a `const` binding.

Properties of a plain `const` object are treated as constants even without `as const`, because
JavaScript cannot express it. Reassigning such a property elsewhere is not detected.

## How receivers are identified

A channel is scoped by the identity of the receiver, so two emitters that reuse an event name
never share a channel.

| Receiver                                      | Scope                                       |
| --------------------------------------------- | ------------------------------------------- |
| Module-level binding, however it is imported  | `src/bus.ts:bus`                            |
| Local variable or parameter                   | `src/app.ts:setup.emitter`                  |
| Class property, through `this` or an instance | `src/svc.ts:Svc.bus`                        |
| Property of an object literal                 | `src/app.ts:app.events.bus`                 |
| `this` inside a class                         | `src/svc.ts:Svc`                            |
| Declared outside the repository               | `global:document`, `global:window.document` |
| Imported from a package                       | `external:some-lib:bus`                     |

Imports are followed to the original declaration, through barrels, renames and default exports, and
a `const` alias resolves to what it aliases. Module-level and global receivers are high confidence;
the others are medium, because the compiler cannot say which object a parameter or instance will be.

A receiver that cannot be identified (a call result, `this` in a plain function, a computed
expression, an unresolved import) is reported as an unresolved observation and is never connected.

Known limits:

- `this` inside a class and a variable holding an instance of that class get different scopes
  (`Svc` versus `app.ts:svc`), so a class that emits to itself and an outside listener on an
  instance are not linked.
- Parameters are scoped per declaration. An emitter passed through a function parameter is not
  linked to the variable it came from.
- Properties of an interface type are scoped by the path that reaches them (`use.a.bus`), not by
  the interface, so two values of one interface type stay separate.

## Invalid configuration

Nothing in `.balk2.json` aborts a run. Unusable content is dropped and described by
`loadBalk2ConfigDetailed`, one `{ path, message }` per problem, for example
`protocols.events.methods[1].eventArg: must be an integer from 0 to 15; entry ignored`.

- A mistake that would make a protocol match **more** than intended rejects the whole entry: an
  unrecognized receiver rule, a missing or invalid `method`, `direction` or `eventArg`, or two
  arguments sharing one position.
- A mistake in a descriptive field drops only that field.
