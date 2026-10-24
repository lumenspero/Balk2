import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildConnectionGraph } from '../cli/build-graph.js';
import type { Balk2Config } from '../config/config.js';
import type { ConnectionMap } from '../types.js';

// Each case analyzes a repository on disk, so keep the default 5s limit out of the way.
vi.setConfig({ testTimeout: 60_000 });

/** Writes the files to a temporary repository and returns the connection map. */
function mapOf(files: Record<string, string>): ConnectionMap {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-py-callback-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(rootDir, name)), { recursive: true });
      fs.writeFileSync(path.join(rootDir, name), content, 'utf8');
    }
    return buildConnectionGraph(rootDir, {} as Balk2Config).build({
      generatedAt: '2026-01-01T00:00:00Z',
    });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

/** The callback relationships as `type from -> to`, sorted, for readable assertions. */
function callbackEdges(map: ConnectionMap): string[] {
  return map.relationships
    .filter((r) => r.type === 'passesCallback')
    .map((r) => `${r.type} ${r.from} -> ${r.to}`)
    .sort();
}

describe('python callbacks passed to threading.Thread (V3 Phase 12.4)', () => {
  it('links the thread function, passed by keyword, to the function that starts it', () => {
    const map = mapOf({
      'main.py':
        'import threading\n\n\ndef worker():\n    pass\n\n\ndef start():\n    threading.Thread(target=worker).start()\n',
    });

    expect(callbackEdges(map)).toEqual(['passesCallback main.py:start -> main.py:worker']);
  });

  it('links a function imported from another repository module', () => {
    const map = mapOf({
      'jobs.py': 'def worker():\n    pass\n',
      'main.py':
        'import threading\nfrom jobs import worker\n\n\ndef start():\n    threading.Thread(target=worker).start()\n',
    });

    expect(callbackEdges(map)).toEqual(['passesCallback main.py:start -> jobs.py:worker']);
  });

  it('reports a callback that is a parameter as unresolved, at low confidence', () => {
    const map = mapOf({
      'main.py':
        'import threading\n\n\ndef start(job):\n    threading.Thread(target=job).start()\n',
    });

    const observation = Object.values(map.unresolved).find(
      (node) => node.reason === 'unresolved-callback',
    );
    expect(observation).toBeDefined();
    expect(map.relationships).toContainEqual(
      expect.objectContaining({
        type: 'passesCallback',
        from: 'main.py:start',
        to: observation?.id,
        confidence: 'low',
      }),
    );
    expect(callbackEdges(map)).toEqual([`passesCallback main.py:start -> ${observation?.id}`]);
  });

  it('links a Thread imported by name from threading', () => {
    const map = mapOf({
      'main.py':
        'from threading import Thread\n\n\ndef worker():\n    pass\n\n\ndef start():\n    Thread(target=worker).start()\n',
    });

    expect(callbackEdges(map)).toEqual(['passesCallback main.py:start -> main.py:worker']);
  });

  it('links a Thread imported by name under an alias', () => {
    const map = mapOf({
      'main.py':
        'from threading import Thread as T\n\n\ndef worker():\n    pass\n\n\ndef start():\n    T(target=worker).start()\n',
    });

    expect(callbackEdges(map)).toEqual(['passesCallback main.py:start -> main.py:worker']);
  });

  it('gives no edge for a name imported from threading that is not Thread', () => {
    const map = mapOf({
      'main.py':
        'from threading import Timer\n\n\ndef worker():\n    pass\n\n\ndef start():\n    Timer(1, worker).start()\n',
    });

    expect(callbackEdges(map)).toEqual([]);
  });

  it('gives no edge for a Thread that is not the threading library', () => {
    const map = mapOf({
      'other.py': 'class Thread:\n    pass\n',
      'main.py':
        'from other import Thread\n\n\ndef worker():\n    pass\n\n\ndef start():\n    Thread(target=worker)\n',
    });

    expect(callbackEdges(map)).toEqual([]);
  });

  it('gives no edge for a threading callable other than Thread', () => {
    const map = mapOf({
      'main.py':
        'import threading\n\n\ndef worker():\n    pass\n\n\ndef start():\n    threading.Timer(1, worker).start()\n',
    });

    expect(callbackEdges(map)).toEqual([]);
  });

  it('links the cleanup function passed to atexit.register', () => {
    const map = mapOf({
      'main.py':
        'import atexit\n\n\ndef cleanup():\n    pass\n\n\ndef setup():\n    atexit.register(cleanup)\n',
    });

    expect(callbackEdges(map)).toEqual(['passesCallback main.py:setup -> main.py:cleanup']);
  });

  it('links the handler passed to signal.signal, and gives no edge for SIG_IGN', () => {
    const map = mapOf({
      'main.py':
        'import signal\n\n\ndef on_term(signum, frame):\n    pass\n\n\ndef setup():\n    signal.signal(signal.SIGTERM, on_term)\n\n\ndef ignore():\n    signal.signal(signal.SIGINT, signal.SIG_IGN)\n',
    });

    expect(callbackEdges(map)).toEqual(['passesCallback main.py:setup -> main.py:on_term']);
  });

  it('links the function given to functools.partial', () => {
    const map = mapOf({
      'main.py':
        'from functools import partial\n\n\ndef add(a, b):\n    return a + b\n\n\ndef setup():\n    return partial(add, 1)\n',
    });

    expect(callbackEdges(map)).toEqual(['passesCallback main.py:setup -> main.py:add']);
  });

  it('links the key function of sorted, passed by keyword', () => {
    const map = mapOf({
      'main.py':
        'def by_name(item):\n    return item\n\n\ndef setup(items):\n    return sorted(items, key=by_name)\n',
    });

    expect(callbackEdges(map)).toEqual(['passesCallback main.py:setup -> main.py:by_name']);
  });

  it('links the function passed to map as its first argument', () => {
    const map = mapOf({
      'main.py':
        'def double(x):\n    return x * 2\n\n\ndef setup(xs):\n    return list(map(double, xs))\n',
    });

    expect(callbackEdges(map)).toEqual(['passesCallback main.py:setup -> main.py:double']);
  });

  it('gives no edge for a builtin name that a repository function shadows', () => {
    const map = mapOf({
      'main.py':
        'def map(f, xs):\n    return xs\n\n\ndef double(x):\n    return x * 2\n\n\ndef setup(xs):\n    return map(double, xs)\n',
    });

    expect(callbackEdges(map)).toEqual([]);
  });

  it('links the function submitted to a ThreadPoolExecutor', () => {
    const map = mapOf({
      'main.py':
        'from concurrent.futures import ThreadPoolExecutor\n\n\ndef worker():\n    pass\n\n\ndef setup():\n    executor = ThreadPoolExecutor(max_workers=2)\n    executor.submit(worker)\n',
    });

    expect(callbackEdges(map)).toEqual(['passesCallback main.py:setup -> main.py:worker']);
  });

  it('links the function mapped over a pool bound by a with statement', () => {
    const map = mapOf({
      'main.py':
        'from concurrent.futures import ThreadPoolExecutor\n\n\ndef double(x):\n    return x * 2\n\n\ndef setup(items):\n    with ThreadPoolExecutor() as pool:\n        return list(pool.map(double, items))\n',
    });

    expect(callbackEdges(map)).toEqual(['passesCallback main.py:setup -> main.py:double']);
  });

  it('gives no edge for submit on a receiver that is not a library executor', () => {
    const map = mapOf({
      'main.py':
        'class Pool:\n    def submit(self, f):\n        pass\n\n\ndef worker():\n    pass\n\n\ndef setup():\n    pool = Pool()\n    pool.submit(worker)\n',
    });

    expect(callbackEdges(map)).toEqual([]);
  });

  it('links a method passed as self.run to a method of the same class', () => {
    const map = mapOf({
      'main.py':
        'import threading\n\n\nclass Worker:\n    def run(self):\n        pass\n\n    def start(self):\n        threading.Thread(target=self.run).start()\n',
    });

    expect(callbackEdges(map)).toEqual([
      'passesCallback main.py:Worker.start -> main.py:Worker.run',
    ]);
  });

  it('links self.run to a method the class inherits', () => {
    const map = mapOf({
      'main.py':
        'import threading\n\n\nclass Base:\n    def run(self):\n        pass\n\n\nclass Worker(Base):\n    def start(self):\n        threading.Thread(target=self.run).start()\n',
    });

    expect(callbackEdges(map)).toEqual(['passesCallback main.py:Worker.start -> main.py:Base.run']);
  });

  it('reports self.attribute that is not a method as unresolved, at low confidence', () => {
    const map = mapOf({
      'main.py':
        'import threading\n\n\nclass Worker:\n    def __init__(self, job):\n        self.job = job\n\n    def start(self):\n        threading.Thread(target=self.job).start()\n',
    });

    const observation = Object.values(map.unresolved).find(
      (node) => node.reason === 'unresolved-callback',
    );
    expect(observation).toBeDefined();
    expect(callbackEdges(map)).toEqual([
      `passesCallback main.py:Worker.start -> ${observation?.id}`,
    ]);
  });
});
