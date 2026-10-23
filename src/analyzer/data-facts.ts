import type * as ts from 'typescript';
import { isDataPathLiteral } from '../facts/path-value.js';
import type { DataReferenceFact, FactLanguage } from '../facts/types.js';
import { dataApiOfLiteral } from './data-api.js';
import { accessContext, isNonAccessLiteral, joinedPathOf } from './data-literals.js';
import { spanOf } from './spans.js';

/**
 * What the front end can resolve about a literal's call. Only a repository session has a type
 * checker, so a single-file analysis passes nothing and keeps the keyword direction.
 */
export interface DataResolution {
  readonly checker: ts.TypeChecker;
  readonly language: FactLanguage;
}

/**
 * Front end for data references: a string literal that may name a data artifact, with the source
 * text that says how the artifact is used. A literal covered by a joined path, searched or compared
 * as text, or not shaped like a data path produces no fact, so the context is read only for real
 * candidates. Reads only; the engine decides the direction.
 */
export function dataReferenceFact(
  literal: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral,
  sourceFile: ts.SourceFile,
  filePath: string,
  resolution?: DataResolution,
): DataReferenceFact | undefined {
  // A path built with path.join or path.resolve is recorded once, under its first piece.
  const joined = joinedPathOf(literal);
  const covered = joined !== undefined && literal !== joined.members[0];
  const path = joined ? joined.value : literal.text;
  if (covered || path === undefined || !isDataPathLiteral(path) || isNonAccessLiteral(literal)) {
    return undefined;
  }
  const api = resolution
    ? dataApiOfLiteral(literal, resolution.checker, resolution.language)
    : undefined;
  return {
    kind: 'data-reference',
    filePath,
    span: spanOf(literal, filePath),
    path,
    context: accessContext(literal, sourceFile),
    ...(api ? { api } : {}),
  };
}
