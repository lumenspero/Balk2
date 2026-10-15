import {
  BUILT_IN_EVENT_PROTOCOLS,
  type EventArgKind,
  type EventDirection,
  type EventProtocol,
  type EventProtocolOptions,
  type ReceiverRule,
} from '../analyzer/event-protocols.js';
import type { LoaderProtocol } from '../analyzer/loader-protocols.js';
import type { ConfigProblem } from './config-problem.js';
import { normalizeLoaders } from './loaders-config.js';
import { normalizeRegistries, type RegistryProtocolsConfig } from './registry-protocols-config.js';
import {
  argField,
  dropped,
  IDENTIFIER_PATTERN,
  isArgIndex,
  isRecord,
  MAX_ARG_INDEX,
  stringList,
} from './protocol-fields.js';

/** Event conventions for a repository; see `protocols.events` in `.balk2.json`. */
export type EventProtocolsConfig = EventProtocolOptions;

/** The `protocols` section of `.balk2.json`: event, registry and loader conventions. */
export interface ProtocolsConfig {
  readonly events?: EventProtocolsConfig;
  readonly registries?: RegistryProtocolsConfig;
  readonly loaders?: readonly LoaderProtocol[];
}

export interface NormalizedProtocolsConfig {
  readonly config?: ProtocolsConfig;
  readonly problems: readonly ConfigProblem[];
}

const DIRECTIONS: readonly EventDirection[] = ['subscribe', 'unsubscribe', 'emit', 'dispatch'];
const ARG_KINDS: readonly EventArgKind[] = ['name', 'event-object'];
const EVENTS_KEYS = new Set(['builtIns', 'disable', 'methods']);
const METHOD_KEYS = new Set([
  'method',
  'direction',
  'eventArg',
  'eventArgKind',
  'payloadArg',
  'listenerArg',
  'optionsArg',
  'once',
  'receiver',
]);
const BUILT_IN_METHODS = new Set(BUILT_IN_EVENT_PROTOCOLS.map((protocol) => protocol.method));

/**
 * Validate the `protocols` section. Anything unusable is dropped and reported.
 *
 * A mistake that would make a protocol match more than intended rejects the whole entry
 * (an unrecognized receiver rule, say). A mistake in a purely descriptive field drops only
 * that field.
 */
export function normalizeProtocolsConfig(value: unknown): NormalizedProtocolsConfig {
  const problems: ConfigProblem[] = [];

  if (!isRecord(value)) {
    problems.push({ path: 'protocols', message: 'must be an object' });
    return { problems };
  }

  let events: EventProtocolsConfig | undefined;
  let registries: RegistryProtocolsConfig | undefined;
  let loaders: readonly LoaderProtocol[] | undefined;
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'events') {
      events = normalizeEvents(entry, problems);
    } else if (key === 'registries') {
      registries = normalizeRegistries(entry, problems);
    } else if (key === 'loaders') {
      loaders = normalizeLoaders(entry, problems);
    } else {
      problems.push({
        path: `protocols.${key}`,
        message:
          'unknown protocol family ignored; only "events", "registries" and "loaders" are supported',
      });
    }
  }

  const config: ProtocolsConfig = {
    ...(events ? { events } : {}),
    ...(registries ? { registries } : {}),
    ...(loaders ? { loaders } : {}),
  };
  return { ...(Object.keys(config).length > 0 ? { config } : {}), problems };
}

function normalizeEvents(
  value: unknown,
  problems: ConfigProblem[],
): EventProtocolsConfig | undefined {
  const base = 'protocols.events';
  if (!isRecord(value)) {
    problems.push({ path: base, message: 'must be an object' });
    return undefined;
  }

  for (const key of Object.keys(value)) {
    if (!EVENTS_KEYS.has(key)) {
      problems.push({ path: `${base}.${key}`, message: 'unknown key ignored' });
    }
  }

  let builtIns: boolean | undefined;
  if ('builtIns' in value) {
    if (typeof value['builtIns'] === 'boolean') {
      builtIns = value['builtIns'];
    } else {
      problems.push({ path: `${base}.builtIns`, message: 'must be true or false' });
    }
  }

  const disable = normalizeDisable(value['disable'], 'disable' in value, problems);
  const methods = normalizeMethods(value['methods'], 'methods' in value, problems);

  const result: EventProtocolsConfig = {
    ...(builtIns !== undefined ? { builtIns } : {}),
    ...(disable.length > 0 ? { disable } : {}),
    ...(methods.length > 0 ? { methods } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeDisable(value: unknown, present: boolean, problems: ConfigProblem[]): string[] {
  if (!present) return [];
  if (!Array.isArray(value)) {
    problems.push({
      path: 'protocols.events.disable',
      message: 'must be an array of method names',
    });
    return [];
  }

  const disabled: string[] = [];
  value.forEach((entry: unknown, index) => {
    const path = `protocols.events.disable[${index}]`;
    if (typeof entry !== 'string' || !IDENTIFIER_PATTERN.test(entry)) {
      problems.push({ path, message: 'must be a method name' });
    } else if (!BUILT_IN_METHODS.has(entry)) {
      problems.push({ path, message: `"${entry}" is not a built-in method; nothing to disable` });
    } else if (!disabled.includes(entry)) {
      disabled.push(entry);
    }
  });
  return disabled;
}

function normalizeMethods(
  value: unknown,
  present: boolean,
  problems: ConfigProblem[],
): EventProtocol[] {
  if (!present) return [];
  if (!Array.isArray(value)) {
    problems.push({ path: 'protocols.events.methods', message: 'must be an array' });
    return [];
  }

  const protocols: EventProtocol[] = [];
  const firstIndexOf = new Map<string, number>();
  value.forEach((entry: unknown, index) => {
    const path = `protocols.events.methods[${index}]`;
    const protocol = normalizeMethod(entry, path, problems);
    if (!protocol) return;

    const first = firstIndexOf.get(protocol.method);
    if (first !== undefined) {
      problems.push({
        path: `${path}.method`,
        message: `duplicate method "${protocol.method}" ignored; first defined at methods[${first}]`,
      });
      return;
    }
    firstIndexOf.set(protocol.method, index);
    protocols.push(protocol);
  });
  return protocols;
}

function normalizeMethod(
  value: unknown,
  path: string,
  problems: ConfigProblem[],
): EventProtocol | undefined {
  if (!isRecord(value)) {
    problems.push({ path, message: 'must be an object; entry ignored' });
    return undefined;
  }

  for (const key of Object.keys(value)) {
    if (!METHOD_KEYS.has(key)) {
      problems.push({ path: `${path}.${key}`, message: 'unknown key ignored' });
    }
  }

  const method = value['method'];
  if (typeof method !== 'string' || !IDENTIFIER_PATTERN.test(method)) {
    problems.push({ path: `${path}.method`, message: 'must be a method name; entry ignored' });
    return undefined;
  }

  const direction = value['direction'];
  if (!isDirection(direction)) {
    problems.push({
      path: `${path}.direction`,
      message: `must be one of ${DIRECTIONS.join(', ')}; entry ignored`,
    });
    return undefined;
  }

  const eventArg = value['eventArg'];
  if (!isArgIndex(eventArg)) {
    problems.push({
      path: `${path}.eventArg`,
      message: `must be an integer from 0 to ${MAX_ARG_INDEX}; entry ignored`,
    });
    return undefined;
  }

  const receiver = normalizeReceiver(value, path, problems);
  if (receiver === null) return undefined;

  const publishes = direction === 'emit' || direction === 'dispatch';
  const listens = direction === 'subscribe' || direction === 'unsubscribe';

  const eventArgKind = optionalField(value, 'eventArgKind', path, problems, (v) =>
    ARG_KINDS.find((kind) => kind === v),
  );
  const keptKind =
    eventArgKind === 'event-object' && !publishes
      ? dropped(`${path}.eventArgKind`, 'only applies to emit and dispatch', problems)
      : eventArgKind;

  const payloadArg = argField(value, 'payloadArg', publishes, 'emit and dispatch', path, problems);
  const listenerArg = argField(
    value,
    'listenerArg',
    listens,
    'subscribe and unsubscribe',
    path,
    problems,
  );
  const optionsArg = argField(
    value,
    'optionsArg',
    listens,
    'subscribe and unsubscribe',
    path,
    problems,
  );

  const onceRaw = value['once'];
  let once: boolean | undefined;
  if ('once' in value) {
    if (typeof onceRaw !== 'boolean') {
      problems.push({ path: `${path}.once`, message: 'must be true or false; field ignored' });
    } else if (direction !== 'subscribe') {
      problems.push({ path: `${path}.once`, message: 'only applies to subscribe; field ignored' });
    } else {
      once = onceRaw;
    }
  }

  // Each argument position must carry one meaning.
  const positions: Array<[string, number | undefined]> = [
    ['eventArg', eventArg],
    ['payloadArg', payloadArg],
    ['listenerArg', listenerArg],
    ['optionsArg', optionsArg],
  ];
  for (let i = 1; i < positions.length; i++) {
    const [name, index] = positions[i] as [string, number | undefined];
    if (index === undefined) continue;
    const clash = positions.slice(0, i).find(([, other]) => other === index);
    if (clash) {
      problems.push({
        path: `${path}.${name}`,
        message: `must differ from ${clash[0]} (both are ${index}); entry ignored`,
      });
      return undefined;
    }
  }

  return {
    method,
    direction,
    eventArg,
    ...(keptKind ? { eventArgKind: keptKind } : {}),
    ...(payloadArg !== undefined ? { payloadArg } : {}),
    ...(listenerArg !== undefined ? { listenerArg } : {}),
    ...(optionsArg !== undefined ? { optionsArg } : {}),
    ...(once !== undefined ? { once } : {}),
    ...(receiver ? { receiver } : {}),
  };
}

/**
 * `undefined` when no receiver rule is given, a rule when valid, and `null` when the rule is
 * unusable (the entry is rejected rather than widened to every receiver).
 */
function normalizeReceiver(
  entry: Record<string, unknown>,
  path: string,
  problems: ConfigProblem[],
): ReceiverRule | undefined | null {
  if (!('receiver' in entry)) return undefined;
  const receiver = entry['receiver'];
  const at = `${path}.receiver`;

  if (receiver === 'any' || receiver === 'event-like') return receiver;

  if (!isRecord(receiver)) {
    problems.push({
      path: at,
      message: 'must be "any", "event-like", or an object with names and/or types; entry ignored',
    });
    return null;
  }

  for (const key of Object.keys(receiver)) {
    if (key !== 'names' && key !== 'types') {
      problems.push({ path: `${at}.${key}`, message: 'unknown key ignored' });
    }
  }

  const names = stringList(receiver['names'], 'names' in receiver, `${at}.names`, problems);
  const types = stringList(receiver['types'], 'types' in receiver, `${at}.types`, problems);
  if (names === null || types === null || (names.length === 0 && types.length === 0)) {
    problems.push({
      path: at,
      message: 'must list at least one valid name or type; entry ignored',
    });
    return null;
  }

  return { ...(names.length > 0 ? { names } : {}), ...(types.length > 0 ? { types } : {}) };
}

function optionalField<T>(
  entry: Record<string, unknown>,
  key: string,
  path: string,
  problems: ConfigProblem[],
  parse: (value: unknown) => T | undefined,
): T | undefined {
  if (!(key in entry)) return undefined;
  const parsed = parse(entry[key]);
  if (parsed === undefined) {
    problems.push({ path: `${path}.${key}`, message: 'has an unrecognized value; field ignored' });
  }
  return parsed;
}

function isDirection(value: unknown): value is EventDirection {
  return DIRECTIONS.some((direction) => direction === value);
}