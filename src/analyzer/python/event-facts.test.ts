import { describe, expect, it } from 'vitest';
import { runEventEngine } from '../../facts/event-engine.js';
import type { EventCallFact } from '../../facts/types.js';
import { analyzePythonCalls } from './calls.js';
import { createPythonEventCollector } from './event-facts.js';
import { createImportResolver } from './modules/import-resolution.js';
import { createSymbolResolver } from './modules/module-exports.js';
import { ModuleIndex } from './modules/module-index.js';

function collect(files: Record<string, string>): EventCallFact[] {
  const index = new ModuleIndex(Object.keys(files));
  const readText = (p: string): string => files[p] ?? '';
  const imports = createImportResolver(index, { roots: ['.'], readText });
  const symbols = createSymbolResolver({ resolver: imports, readText });
  const ctx = { symbols, imports };
  const sources = Object.entries(files).map(([filePath, source]) => ({ filePath, source }));
  const collector = createPythonEventCollector(sources, ctx);
  analyzePythonCalls(sources, ctx, {}, collector.observer);
  return collector.facts();
}

/** One line per event call: `owner direction name emitter [listener=...] [once]`. */
function lines(files: Record<string, string>): string[] {
  return collect(files).map((f) => {
    const name = f.name.kind === 'static' ? f.name.name : f.name.kind;
    const scope = f.receiver.identity.kind === 'resolved' ? f.receiver.identity.scope : '?';
    const listener = f.listener === undefined ? '' : ` listener=${f.listener}`;
    return `${f.owner} ${f.direction} ${name} ${scope}${listener}${f.once ? ' once' : ''}`;
  });
}

const PYEE = 'from pyee import EventEmitter\n\nbus = EventEmitter()\n';

describe('python event facts: pyee emitters', () => {
  it('reads subscribe and emit on a module-level emitter, with the listener', () => {
    expect(
      lines({
        'm.py': `${PYEE}\n\ndef on_ready():\n    return 1\n\n\ndef start():\n    bus.on('ready', on_ready)\n\n\ndef publish():\n    bus.emit('ready')\n`,
      }),
    ).toEqual([
      'm.py:start subscribe ready m.py:bus listener=m.py:on_ready',
      'm.py:publish emit ready m.py:bus',
    ]);
  });

  it('marks once subscriptions and reads remove_listener as an unsubscribe', () => {
    expect(
      lines({
        'm.py': `${PYEE}\n\ndef on_ready():\n    return 1\n\n\ndef start():\n    bus.once('ready', on_ready)\n\n\ndef stop():\n    bus.remove_listener('ready', on_ready)\n`,
      }),
    ).toEqual([
      'm.py:start subscribe ready m.py:bus listener=m.py:on_ready once',
      'm.py:stop unsubscribe ready m.py:bus listener=m.py:on_ready',
    ]);
  });

  it('treats a decorated def as the listener of a decorator subscription', () => {
    expect(
      lines({
        'm.py': `${PYEE}\n\n@bus.on('ready')\ndef handler():\n    return 1\n`,
      }),
    ).toEqual(['m.py subscribe ready m.py:bus listener=m.py:handler']);
  });

  it('gives a non-literal event name as dynamic, for an observation', () => {
    expect(
      lines({
        'm.py': `${PYEE}\n\ndef publish(name):\n    bus.emit(name)\n`,
      }),
    ).toEqual(['m.py:publish emit dynamic m.py:bus']);
  });

  it('scopes a function-local emitter to its function', () => {
    expect(
      lines({
        'm.py':
          "from pyee import EventEmitter\n\n\ndef run():\n    bus = EventEmitter()\n    bus.emit('ready')\n",
      }),
    ).toEqual(['m.py:run emit ready m.py:run.bus']);
  });

  it('types an annotated parameter as the emitter', () => {
    expect(
      lines({
        'm.py':
          "from pyee import EventEmitter\n\n\ndef run(bus: EventEmitter):\n    bus.emit('ready')\n",
      }),
    ).toEqual(['m.py:run emit ready m.py:run.bus']);
  });

  it('reads an emitter through a repository class that subclasses it', () => {
    expect(
      lines({
        'm.py':
          "from pyee import EventEmitter\n\n\nclass Bus(EventEmitter):\n    pass\n\n\nbus = Bus()\n\n\ndef publish():\n    bus.emit('ready')\n",
      }),
    ).toEqual(['m.py:publish emit ready m.py:bus']);
  });

  it('reads a module import of pyee by its full dotted name', () => {
    expect(
      lines({
        'm.py':
          "import pyee\n\nbus = pyee.EventEmitter()\n\n\ndef publish():\n    bus.emit('ready')\n",
      }),
    ).toEqual(['m.py:publish emit ready m.py:bus']);
  });
});

describe('python event facts: negatives', () => {
  it('gives no fact for a receiver of unknown type', () => {
    expect(lines({ 'm.py': "def f(x):\n    x.emit('ready')\n" })).toEqual([]);
  });

  it('gives no fact for an EventEmitter from another library', () => {
    expect(
      lines({
        'm.py':
          "from other import EventEmitter\n\nbus = EventEmitter()\n\n\ndef publish():\n    bus.emit('ready')\n",
      }),
    ).toEqual([]);
  });

  it('gives no fact for a method pyee does not map', () => {
    expect(
      lines({ 'm.py': `${PYEE}\n\ndef check():\n    return bus.listeners('ready')\n` }),
    ).toEqual([]);
  });
});

describe('python event facts: channels through the engine', () => {
  it('connects a subscriber and a publisher on the same emitter, and nothing else', () => {
    const files = {
      'm.py': `${PYEE}\nother = EventEmitter()\n\n\ndef on_ready():\n    return 1\n\n\ndef start():\n    bus.on('ready', on_ready)\n\n\ndef publish():\n    bus.emit('ready')\n\n\ndef unrelated():\n    other.emit('ready')\n`,
    };
    const channels = runEventEngine({ facts: collect(files) }).flatMap((edge) =>
      edge.kind === 'channel'
        ? [`${edge.relationship} ${edge.from} ${edge.scope}#${edge.name}`]
        : [],
    );
    expect(channels).toEqual([
      'subscribes m.py:on_ready m.py:bus#ready',
      'emits m.py:publish m.py:bus#ready',
      'emits m.py:unrelated m.py:other#ready',
    ]);
  });
});

describe('python event facts: blinker named signals', () => {
  it('shares one library-scoped channel across every signal of the same name', () => {
    expect(
      lines({
        'm.py':
          "from blinker import signal\n\nready = signal('ready')\n\n\ndef on_ready(sender):\n    return 1\n\n\ndef start():\n    ready.connect(on_ready)\n\n\ndef publish():\n    other = signal('ready')\n    other.send()\n",
      }),
    ).toEqual([
      'm.py:start subscribe ready blinker listener=m.py:on_ready',
      'm.py:publish emit ready blinker',
    ]);
  });

  it('reads a decorator connect as a subscription of the decorated def', () => {
    expect(
      lines({
        'm.py':
          "from blinker import signal\n\nready = signal('ready')\n\n\n@ready.connect\ndef handler(sender):\n    return 1\n",
      }),
    ).toEqual(['m.py subscribe ready blinker listener=m.py:handler']);
  });

  it('gives a dynamic name when the signal name is not a literal', () => {
    expect(
      lines({
        'm.py':
          'from blinker import signal\n\n\ndef publish(name):\n    s = signal(name)\n    s.send()\n',
      }),
    ).toEqual(['m.py:publish emit dynamic blinker']);
  });
});

describe('python event facts: django signals and threading events', () => {
  it('scopes a django Signal by its binding, and reads connect and send', () => {
    expect(
      lines({
        'm.py':
          'from django.dispatch import Signal\n\nready = Signal()\n\n\ndef on_ready(sender, **kwargs):\n    return 1\n\n\ndef start():\n    ready.connect(on_ready)\n\n\ndef publish():\n    ready.send(sender=None)\n    ready.send_robust(sender=None)\n',
      }),
    ).toEqual([
      'm.py:start subscribe ready m.py:ready listener=m.py:on_ready',
      'm.py:publish emit ready m.py:ready',
      'm.py:publish emit ready m.py:ready',
    ]);
  });

  it('reads threading.Event: set emits and wait subscribes, on the event binding', () => {
    expect(
      lines({
        'm.py':
          'from threading import Event\n\ndone = Event()\n\n\ndef waiter():\n    done.wait()\n\n\ndef setter():\n    done.set()\n',
      }),
    ).toEqual(['m.py:waiter subscribe done m.py:done', 'm.py:setter emit done m.py:done']);
  });

  it('keeps two threading events with the same name apart', () => {
    expect(
      lines({
        'm.py':
          'from threading import Event\n\n\ndef run():\n    a = Event()\n    b = Event()\n    a.set()\n    b.wait()\n',
      }),
    ).toEqual(['m.py:run emit a m.py:run.a', 'm.py:run subscribe b m.py:run.b']);
  });
});
