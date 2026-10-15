/**
 * A configured function that receives a callback as one of its arguments, such as an event
 * registration (`onReady(handler)`). The callback is linked from the caller with `passesCallback`.
 *
 * Only the function name is matched. Nothing is inferred from a name alone: a project opts in by
 * listing its functions under `protocols.callbacks`.
 */
export interface CallbackProtocol {
  /** The function name, a JavaScript identifier, matched on a plain call or a method call */
  readonly function: string;
  /** Zero-based argument position that holds the callback */
  readonly callbackArg: number;
}
