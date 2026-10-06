/** A deterministic note about `.balk2.json` content that was ignored or could not be used. */
export interface ConfigProblem {
  /** Dotted location in the configuration, e.g. `protocols.events.methods[1].eventArg` */
  readonly path: string;
  readonly message: string;
}
