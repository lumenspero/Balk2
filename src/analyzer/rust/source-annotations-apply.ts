import type { Annotation } from '../annotations.js';
import {
  collectAnnotations,
  type AnnotatedFile,
  type SourceAnnotationResult,
} from '../source-annotation-engine.js';
import type { PendingFunction } from './names/module-index.js';
import { scanRustSourceComments } from './source-comments.js';

/**
 * Read `// balk2:` directives from every Rust file. A directive's owner is the innermost function
 * whose body holds the statement it sits above, or the file itself at top level.
 *
 * `sources` maps each repository-relative `.rs` path to its text. `functions` is every function of
 * the crates, whose spans give each function's lines.
 */
export function collectRustSourceAnnotations(
  sources: ReadonlyMap<string, string>,
  functions: readonly PendingFunction[],
  configAnnotations: readonly Annotation[] = [],
): SourceAnnotationResult {
  const files: AnnotatedFile[] = [];
  for (const filePath of [...sources.keys()].sort()) {
    const text = sources.get(filePath) ?? '';
    const scan = scanRustSourceComments(filePath, text);
    if (scan.annotations.length === 0 && scan.problems.length === 0) continue;
    const owned = functions.filter((fn) => fn.owner.file === filePath);
    files.push({
      filePath,
      scan,
      ownerOfLine: (line) => innermostOwner(owned, line) ?? filePath,
    });
  }
  return collectAnnotations(files, configAnnotations);
}

/** The id of the innermost function whose span holds a line, or undefined at top level. */
function innermostOwner(functions: readonly PendingFunction[], line: number): string | undefined {
  let best: PendingFunction | undefined;
  for (const fn of functions) {
    const { line: start, endLine: end } = fn.item.span;
    if (start > line || end < line) continue;
    if (best === undefined || start >= best.item.span.line) best = fn;
  }
  return best?.id;
}
