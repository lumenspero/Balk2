import type { Expr } from './ast.js';
import { formatExpr } from './expression-format.js';
import { spanKey, type FileInfo } from './inheritance.js';

/**
 * The identity of a receiver name, shared by the event and registry passes: `<file>:<name>` at
 * module level, `<file>:<scope>.<name>` elsewhere. A name the scope analysis cannot place has no
 * identity.
 */
export function identityOf(
  name: Extract<Expr, { kind: 'name' }>,
  info: FileInfo,
): string | undefined {
  const resolution = info.uses.get(spanKey(name.span))?.resolution;
  if (resolution?.kind !== 'scope') return undefined;
  const scope = info.scopes.scopes.find((s) => s.id === resolution.scope);
  if (scope === undefined) return undefined;
  return scope.span === null
    ? `${info.filePath}:${name.id}`
    : `${info.filePath}:${scope.label}.${name.id}`;
}

const MAX_SUBJECT_LENGTH = 80;

/** An expression as shown in an observation: one line, truncated to 80 characters. */
export function subjectOf(e: Expr): string {
  const text = formatExpr(e).replace(/\s+/g, ' ');
  return text.length > MAX_SUBJECT_LENGTH ? `${text.slice(0, MAX_SUBJECT_LENGTH - 1)}…` : text;
}
