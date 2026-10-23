/**
 * Python event facts (V3 Phase 12.1). Reads method calls on Python event objects from library
 * types, using the receiver typing the call pass already computed, and emits event-call facts. The
 * event engine (Phase 2.3) turns them into channels, the same way it does for JS/TS.
 *
 * The library catalog (`PYTHON_EVENT_EMITTERS`) says three things about each library:
 * - which classes it is, under every dotted name they can be imported as;
 * - which methods subscribe, unsubscribe or emit, and which argument is the listener;
 * - where the channel comes from:
 *   - scope `receiver`: the receiver's binding, so two objects never share a channel;
 *   - scope `library`: a process-wide namespace, as blinker's named signals are;
 *   and the channel name:
 *   - `argument`: the event name passed to the method (pyee);
 *   - `binding`: the name the receiver is bound to (Django's `Signal`, `threading.Event`);
 *   - `payload`: the name the receiver was constructed with (blinker's `signal('ready')`).
 *
 * A repository class counts as an emitter when a base it names, directly or through its
 * repository MRO, is a library class.
 *
 * Not yet read: receivers that are not plain names (`self.bus`, a call result), and names bound
 * by an import from another repository module. Such a receiver is not an emitter, and its calls
 * give no edge. Event names that the source does not state as a plain literal are observations.
 */
import type { CallArg, Expr } from './ast.js';
import { formatExpr } from './expression-format.js';
import {
  analyzeInheritance,
  resolveBase,
  spanKey,
  toSourceSpan,
  type FileInfo,
  type InheritanceContext,
  type InheritanceFile,
} from './inheritance.js';
import type { CallContext, CallObserver } from './calls.js';
import { localTypeOf, plainStringValue } from './typed-receivers.js';
import type { TypeName } from '../../facts/local-types.js';
import type { EventCallFact, EventDirectionFact, EventNameFact } from '../../facts/types.js';
import { relationshipOf } from '../event-protocols.js';

/** One method of a library: what it does on the channel, and which argument is a listener. */
interface LibraryMethod {
  readonly method: string;
  readonly direction: EventDirectionFact;
  /** Zero-based index of the listener argument (subscribe and unsubscribe only). */
  readonly listenerArg?: number;
  /** The listener runs at most once. */
  readonly once?: boolean;
}

/** Where a channel's name comes from. */
type ChannelName = 'argument' | 'binding' | 'payload';

/** A library class, the methods it has, and how its channels are named and scoped. */
interface LibraryEmitter {
  readonly types: readonly string[];
  readonly methods: readonly LibraryMethod[];
  readonly name: ChannelName;
  /** `receiver` scopes a channel by the binding; `library` puts every channel in `libraryScope`. */
  readonly scope: 'receiver' | 'library';
  readonly libraryScope?: string;
}

/** Library event classes (Phase 12.1). Method names are those of each library's public API. */
export const PYTHON_EVENT_EMITTERS: readonly LibraryEmitter[] = [
  {
    types: ['pyee.EventEmitter', 'pyee.base.EventEmitter', 'pyee.asyncio.AsyncIOEventEmitter'],
    name: 'argument',
    scope: 'receiver',
    methods: [
      { method: 'on', direction: 'subscribe', listenerArg: 1 },
      { method: 'once', direction: 'subscribe', listenerArg: 1, once: true },
      { method: 'remove_listener', direction: 'unsubscribe', listenerArg: 1 },
      { method: 'emit', direction: 'emit' },
    ],
  },
  {
    types: ['blinker.signal'],
    name: 'payload',
    scope: 'library',
    libraryScope: 'blinker',
    methods: [
      { method: 'connect', direction: 'subscribe', listenerArg: 0 },
      { method: 'disconnect', direction: 'unsubscribe', listenerArg: 0 },
      { method: 'send', direction: 'emit' },
    ],
  },
  {
    types: ['django.dispatch.Signal', 'django.dispatch.dispatcher.Signal'],
    name: 'binding',
    scope: 'receiver',
    methods: [
      { method: 'connect', direction: 'subscribe', listenerArg: 0 },
      { method: 'disconnect', direction: 'unsubscribe', listenerArg: 0 },
      { method: 'send', direction: 'emit' },
      { method: 'send_robust', direction: 'emit' },
    ],
  },
  {
    types: ['threading.Event', 'asyncio.Event', 'asyncio.locks.Event'],
    name: 'binding',
    scope: 'receiver',
    methods: [
      { method: 'set', direction: 'emit' },
      { method: 'wait', direction: 'subscribe' },
    ],
  },
];

const MAX_SUBJECT_LENGTH = 80;

/** The collector: pass `observer` to `analyzePythonCalls`, then read `facts()`. */
export interface PythonEventCollector {
  readonly observer: CallObserver;
  /** The event-call facts, in the order the calls were read. */
  facts(): EventCallFact[];
}

export function createPythonEventCollector(
  files: readonly InheritanceFile[],
  ctx: InheritanceContext,
): PythonEventCollector {
  // The library classes each repository class names as a base, by class id.
  const libraryBases = new Map<string, string[]>();
  for (const c of analyzeInheritance(files, ctx).classes) {
    const names = c.bases.flatMap((base) =>
      base.importedAs === undefined ? [] : [base.importedAs],
    );
    libraryBases.set(c.id, [...(libraryBases.get(c.id) ?? []), ...names]);
  }

  const facts: EventCallFact[] = [];
  const observer: CallObserver = {
    onCall: (site) => {
      const owner = site.owner ?? site.info.filePath;
      const fact = factOf(
        site,
        site.call,
        site.call.func,
        site.call.args,
        owner,
        undefined,
        libraryBases,
      );
      if (fact) facts.push(fact);
    },
    onDecorator: (site) => {
      // `@ready.connect` or `@bus.on('ready')` above a def subscribes that def.
      const owner = site.enclosing ?? site.info.filePath;
      const decorator = site.decorator;
      const fact =
        decorator.kind === 'call'
          ? factOf(
              site,
              decorator,
              decorator.func,
              decorator.args,
              owner,
              site.decoratedId,
              libraryBases,
            )
          : factOf(site, decorator, decorator, [], owner, site.decoratedId, libraryBases);
      if (fact) facts.push(fact);
    },
  };
  return { observer, facts: () => facts };
}

/**
 * The event-call fact of a method call on a library object, or undefined for any other call.
 * `subject` is the expression shown in observations; `func` is the attribute being called.
 */
function factOf(
  site: CallContext,
  subject: Expr,
  func: Expr,
  args: readonly CallArg[],
  owner: string,
  decoratedListener: string | undefined,
  libraryBases: ReadonlyMap<string, readonly string[]>,
): EventCallFact | undefined {
  if (func.kind !== 'attribute' || func.value.kind !== 'name') return undefined;
  const receiver = func.value;
  const method = func.attr;

  const typed = localTypeOf(receiver, site.info, site.index);
  if (typed === undefined) return undefined;
  const emitter = libraryOf(site, typed.name, libraryBases);
  const spec = emitter?.methods.find((m) => m.method === method);
  if (emitter === undefined || spec === undefined) return undefined;

  const scope =
    emitter.scope === 'library' ? emitter.libraryScope : identityOf(receiver, site.info);
  if (scope === undefined) return undefined;

  const positional = args.filter((arg) => arg.kind === 'positional');
  const listener =
    spec.listenerArg === undefined
      ? undefined
      : (decoratedListener ?? listenerOf(site, positional[spec.listenerArg]?.value));

  return {
    kind: 'event-call',
    filePath: site.info.filePath,
    span: toSourceSpan(subject.span, site.info.filePath),
    owner,
    subject: subjectOf(subject),
    direction: spec.direction,
    relationship: relationshipOf(spec.direction),
    protocolSource: 'built-in',
    eventLikeReceiver: false,
    once: spec.once === true,
    claimed: false,
    receiver: {
      identity: { kind: 'resolved', scope, confidence: 'high' },
      qualifies: true,
      qualificationEvidence: 'ast',
    },
    name: channelNameOf(emitter.name, receiver.id, positional[0]?.value, typed.payload),
    ...(listener === undefined ? {} : { listener }),
    evidence: 'ast',
  };
}

/** The library class a receiver type is, directly or through a repository base class. */
function libraryOf(
  site: CallContext,
  type: TypeName,
  libraryBases: ReadonlyMap<string, readonly string[]>,
): LibraryEmitter | undefined {
  if (type.kind === 'external') return emitterNamed(type.name);
  for (const id of site.mro.get(type.id) ?? []) {
    for (const name of libraryBases.get(id) ?? []) {
      const emitter = emitterNamed(name);
      if (emitter !== undefined) return emitter;
    }
  }
  return undefined;
}

function emitterNamed(name: string): LibraryEmitter | undefined {
  return PYTHON_EVENT_EMITTERS.find((emitter) => emitter.types.includes(name));
}

/**
 * The identity of a receiver name: `<file>:<name>` at module level, `<file>:<scope>.<name>`
 * elsewhere. A name the scope analysis cannot place has no identity.
 */
function identityOf(name: Extract<Expr, { kind: 'name' }>, info: FileInfo): string | undefined {
  const resolution = info.uses.get(spanKey(name.span))?.resolution;
  if (resolution?.kind !== 'scope') return undefined;
  const scope = info.scopes.scopes.find((s) => s.id === resolution.scope);
  if (scope === undefined) return undefined;
  return scope.span === null
    ? `${info.filePath}:${name.id}`
    : `${info.filePath}:${scope.label}.${name.id}`;
}

/** The listener named by an argument, when it is a function or method of the repository. */
function listenerOf(site: CallContext, arg: Expr | undefined): string | undefined {
  if (arg === undefined) return undefined;
  const target = resolveBase(arg, site.info, site.ctx, site.declared);
  if (target?.kind !== 'symbol') return undefined;
  const kind = site.types.get(target.id);
  return kind === 'function' || kind === 'method' ? target.id : undefined;
}

/** The channel name, from wherever the library takes it. */
function channelNameOf(
  source: ChannelName,
  bindingName: string,
  firstArg: Expr | undefined,
  payload: string | undefined,
): EventNameFact {
  switch (source) {
    case 'argument':
      return nameOf(firstArg);
    case 'binding':
      return { kind: 'static', name: bindingName };
    case 'payload':
      return payload === undefined
        ? { kind: 'dynamic', reason: 'signal name is not a string literal' }
        : { kind: 'static', name: payload };
  }
}

/** The event name an argument gives: a plain string literal, or a dynamic name with its reason. */
function nameOf(arg: Expr | undefined): EventNameFact {
  if (arg === undefined) return { kind: 'not-a-name' };
  const value = plainStringValue(arg);
  if (value !== undefined) return { kind: 'static', name: value };
  if (arg.kind === 'constant' && arg.type === 'str') {
    return { kind: 'dynamic', reason: 'string literal is not a plain name' };
  }
  return {
    kind: 'dynamic',
    reason: arg.kind === 'fstring' ? 'formatted event name' : 'event name is not a string literal',
  };
}

function subjectOf(e: Expr): string {
  const text = formatExpr(e).replace(/\s+/g, ' ');
  return text.length > MAX_SUBJECT_LENGTH ? `${text.slice(0, MAX_SUBJECT_LENGTH - 1)}…` : text;
}
