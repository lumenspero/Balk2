import type { ReceiverRule } from './event-protocols.js';

/**
 * A configured function that loads a module from a specifier argument, such as a plugin loader.
 *
 * - Without `receiver`, it matches a plain call to that identifier: `loadPlugin('./x')`.
 * - With `receiver`, it matches a method call on a matching object: `plugins.load('./x')`.
 *
 * The specifier is read from `specifierArg`. A loader whose specifier is not a constant is a
 * dynamic load; one whose constant names no repository file is left silent for now.
 */
export interface LoaderProtocol {
  /** The function or method name, a JavaScript identifier */
  readonly function: string;
  /** Zero-based argument position that holds the module specifier */
  readonly specifierArg: number;
  /** Restricts a method call to receivers matching this rule; omitted matches plain calls */
  readonly receiver?: ReceiverRule;
}

export interface LoaderProtocolOptions {
  /** Project loaders from `protocols.loaders` in `.balk2.json`. Empty when unconfigured. */
  readonly loaders?: readonly LoaderProtocol[];
}
