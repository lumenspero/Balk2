import type { SourceSpan } from '../../types.js';

/**
 * One call that starts a process, as a front end read it (V3 Phase 14.5).
 *
 * `argv` is the command as literal strings, program first. It is `null` when any part of the
 * command is not a literal, so the call is an observation rather than an edge.
 */
export interface ProcessCall {
  /** Repository-relative file that makes the call. */
  readonly file: string;
  /** The symbol id of the enclosing function, or the file when the call is at module level. */
  readonly owner: string;
  /** The API as written, resolved through imports: `subprocess.run`, `spawn`, `Command::new`. */
  readonly callee: string;
  readonly argv: readonly string[] | null;
  readonly span: SourceSpan;
  /** `manifest` for a command a manifest declares (package.json, Makefile, pyproject). Defaults to `ast`. */
  readonly evidence?: 'ast' | 'manifest';
  /** The directory the command runs in. Defaults to the nearest package.json directory. */
  readonly workingDir?: string;
}
