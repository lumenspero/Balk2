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

## Invalid configuration

Nothing in `.balk2.json` aborts a run. Unusable content is dropped and described by
`loadBalk2ConfigDetailed`, one `{ path, message }` per problem, for example
`protocols.events.methods[1].eventArg: must be an integer from 0 to 15; entry ignored`.

- A mistake that would make a protocol match **more** than intended rejects the whole entry: an
  unrecognized receiver rule, a missing or invalid `method`, `direction` or `eventArg`, or two
  arguments sharing one position.
- A mistake in a descriptive field drops only that field.
