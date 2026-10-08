import type * as ts from 'typescript';
import type { RepositoryProgram } from './repository-program.js';

/** Maps a parsed source file back to its repository-relative path. */
export type PathLookup = (sourceFile: ts.SourceFile) => string | undefined;

export function createPathLookup(repository: RepositoryProgram): PathLookup {
  const paths = new Map<ts.SourceFile, string>();
  for (const [filePath, sourceFile] of repository.sourceFiles) paths.set(sourceFile, filePath);
  return (sourceFile) => paths.get(sourceFile);
}
