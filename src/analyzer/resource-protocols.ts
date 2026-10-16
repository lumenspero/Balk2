/**
 * A configured function that loads a resource from a path argument, such as a template renderer
 * (`loadTemplate('tpl/card.html')`). Only the function name is matched; nothing is inferred from
 * `fs` reads in this version.
 *
 * A path starting with `.` resolves relative to the calling file. Any other path resolves from the
 * repository root.
 */
export interface ResourceProtocol {
  /** The function name, a JavaScript identifier, matched on a plain call or a method call */
  readonly function: string;
  /** Zero-based argument position that holds the resource path */
  readonly specifierArg: number;
}
