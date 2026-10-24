import * as ts from 'typescript';
import type { Annotation } from './annotations.js';
import { collectAnnotations, type AnnotatedFile, type SourceAnnotationResult } from './source-annotation-engine.js';
import { enclosingOwner } from './owner.js';
import type { RepositoryProgram } from './repository-program.js';
import { scanSourceAnnotations } from './js-source-comments.js';

export type { SourceAnnotationResult };

/**
 * Read `// balk2:` directives from every JS/TS file in the repository. A directive's owner is the
 * symbol that encloses the statement it sits above, or the file itself at top level.
 */
export function collectSourceAnnotations(
  repository: RepositoryProgram,
  configAnnotations: readonly Annotation[],
): SourceAnnotationResult {
  const files: AnnotatedFile[] = [];
  const sorted = [...repository.sourceFiles].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [filePath, sourceFile] of sorted) {
    if (sourceFile.isDeclarationFile) continue;
    files.push({
      filePath,
      scan: scanSourceAnnotations(filePath, sourceFile.getFullText()),
      ownerOfLine: (line) =>
        ownerAtPosition(sourceFile, sourceFile.getPositionOfLineAndCharacter(line, 0), filePath),
    });
  }
  return collectAnnotations(files, configAnnotations);
}

/**
 * The owner of the innermost node that contains a position: the enclosing symbol, or the file when
 * the position is at top level.
 */
function ownerAtPosition(sourceFile: ts.SourceFile, pos: number, filePath: string): string {
  let node: ts.Node = sourceFile;
  const find = (candidate: ts.Node): void => {
    if (candidate.getStart(sourceFile) <= pos && pos < candidate.getEnd()) {
      node = candidate;
      ts.forEachChild(candidate, find);
    }
  };
  ts.forEachChild(sourceFile, find);
  return enclosingOwner(node, filePath);
}
