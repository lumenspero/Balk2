import type { Annotation, AnnotationProblem } from './annotations.js';
import { ownersByLine } from './python-mechanisms.js';
import { normalizePath } from '../graph.js';
import { scanPythonSourceAnnotations } from './python-source-annotations.js';

export interface PythonSourceAnnotationResult {
  readonly annotations: readonly Annotation[];
  readonly problems: readonly AnnotationProblem[];
}

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
  const problems: AnnotationProblem[] = [];
  const bySource = new Map<string, Annotation>();

  for (const filePath of Object.keys(files).sort()) {
    const text = files[filePath] ?? '';
    const normalized = normalizePath(filePath);
    const scan = scanPythonSourceAnnotations(normalized, text);
    for (const problem of scan.problems) {
      problems.push({ path: problem.path, message: problem.message });
    }
    if (scan.annotations.length === 0) continue;

    const owners = ownersByLine(text, normalized);
    for (const { line, annotation } of scan.annotations) {
      // The directive sits above its statement, so the statement's owner is on the next line.
      const owner = owners[line] ?? normalized;
      if (annotation.from !== owner) {
        problems.push({
          path: `${normalized}:${line}`,
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
