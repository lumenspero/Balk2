import type { Annotation } from './annotations.js';
import { ownersByLine } from './python-mechanisms.js';
import { normalizePath } from '../graph.js';
import { scanPythonSourceAnnotations } from './python-source-comments.js';
import {
  collectAnnotations,
  type AnnotatedFile,
  type SourceAnnotationResult,
} from './source-annotation-engine.js';

export type PythonSourceAnnotationResult = SourceAnnotationResult;

/**
 * Read `# balk2:` directives from every Python file. A directive is accepted only when its `from`
 * is the owner the analyzer records for the line it annotates. Where a source directive and a config
 * annotation name the same edge, the source directive wins, matching the JavaScript rule.
 *
 * `files` maps each repository-relative `.py` path to its text.
 */
export function collectPythonSourceAnnotations(
  files: Record<string, string>,
  configAnnotations: readonly Annotation[],
): PythonSourceAnnotationResult {
  const annotated: AnnotatedFile[] = [];
  for (const filePath of Object.keys(files).sort()) {
    const text = files[filePath] ?? '';
    const normalized = normalizePath(filePath);
    let owners: string[] | undefined;
    annotated.push({
      filePath: normalized,
      scan: scanPythonSourceAnnotations(normalized, text),
      // The directive sits above its statement, so the statement's owner is on the next line.
      ownerOfLine: (line) => {
        owners ??= ownersByLine(text, normalized);
        return owners[line] ?? normalized;
      },
    });
  }
  return collectAnnotations(annotated, configAnnotations);
}
