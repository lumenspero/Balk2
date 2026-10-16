import * as ts from 'typescript';
import type { Annotation, AnnotationProblem } from './annotations.js';
import { enclosingOwner } from './owner.js';
import type { RepositoryProgram } from './repository-program.js';
import { scanSourceAnnotations } from './source-annotations.js';

export interface SourceAnnotationResult {
  /** Accepted directives, with source comments already overriding config for the same edge. */
  readonly annotations: readonly Annotation[];
  readonly problems: readonly AnnotationProblem[];
}

/**
 * Read `// balk2:` directives from every JS/TS file in the repository. A directive is accepted only
 * when its `from` is the symbol that encloses the comment's statement, or the file itself at top
 * level. Anything else is reported, so a comment cannot annotate an edge elsewhere in the file.
 *
 * Where a source directive and a config annotation name the same edge, the source directive wins.
 */
export function collectSourceAnnotations(
  repository: RepositoryProgram,
  configAnnotations: readonly Annotation[],
): SourceAnnotationResult {
  const problems: AnnotationProblem[] = [];
  const bySource = new Map<string, Annotation>();

  const files = [...repository.sourceFiles].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [filePath, sourceFile] of files) {
    if (sourceFile.isDeclarationFile) continue;
    const scan = scanSourceAnnotations(filePath, sourceFile.getFullText());
    for (const problem of scan.problems) {
      problems.push({ path: problem.path, message: problem.message });
    }

    for (const { line, annotation } of scan.annotations) {
      const statementPos = sourceFile.getPositionOfLineAndCharacter(line, 0);
      const owner = ownerAtPosition(sourceFile, statementPos, filePath);
      if (annotation.from !== owner) {
        problems.push({
          path: `${filePath}:${line}`,
          message: `source annotation from ${annotation.from} does not match the enclosing owner ${owner}; annotation ignored`,
        });
        continue;
      }
      bySource.set(keyOf(annotation), annotation);
    }
  }

  const merged: Annotation[] = [];
  const seen = new Set<string>();
  for (const annotation of bySource.values()) {
    seen.add(keyOf(annotation));
    merged.push(annotation);
  }
  for (const annotation of configAnnotations) {
    const key = keyOf(annotation);
    if (seen.has(key)) {
      problems.push({
        path: 'annotations',
        message: `${annotation.type} from ${annotation.from} to ${annotation.to} is set in a source comment; the config annotation is ignored`,
      });
      continue;
    }
    seen.add(key);
    merged.push(annotation);
  }

  return { annotations: merged, problems };
}

function keyOf(annotation: Annotation): string {
  return `${annotation.type}\u0000${annotation.from}\u0000${annotation.to}`;
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
