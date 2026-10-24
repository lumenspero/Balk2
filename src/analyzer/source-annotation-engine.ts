import type { Annotation, AnnotationProblem } from './annotations.js';

/** A directive found in a source comment, with the 1-based line it was written on. */
export interface SourceAnnotation {
  readonly line: number;
  readonly annotation: Annotation;
}

export interface SourceAnnotationProblem {
  readonly path: string;
  readonly message: string;
}

export interface SourceAnnotationScan {
  readonly annotations: SourceAnnotation[];
  readonly problems: SourceAnnotationProblem[];
}

/** A comment found in a source file: its text after the marker, and where it starts and ends. */
export interface FoundComment {
  /** The comment text after its marker (`//` or `#`), untrimmed. */
  readonly body: string;
  /** 1-based line the comment starts on. */
  readonly line: number;
  /** Character offset just after the comment, used to find the next token. */
  readonly end: number;
}

const PREFIX = 'balk2:';
const CONFIDENCE_PREFIX = 'confidence=';
const CONFIDENCES: readonly string[] = ['high', 'medium', 'low'];

/** Relationship types a comment may name. Legacy reverse links are not accepted. */
const RELATIONSHIP_TYPES: ReadonlySet<string> = new Set([
  'imports',
  'calls',
  'passesCallback',
  'extends',
  'implements',
  'references',
  'exports',
  'emits',
  'subscribes',
  'unsubscribes',
  'dispatches',
  'registers',
  'resolves',
  'routesTo',
  'definesMetadata',
  'readsMetadata',
  'usesResource',
  'readsState',
  'writesState',
  'deletesState',
  'generates',
  'consumes',
  'reads',
  'writes',
  'transforms',
]);


/**
 * Turn comments into directives. Shared by every language: a comment becomes a directive when its
 * body starts with `balk2:`, and the directive must sit directly above the next token. `nextLine`
 * reports the line of the next token after a character offset, so each language supplies its own
 * notion of comments and whitespace.
 */
export function readDirectives(
  filePath: string,
  comments: readonly FoundComment[],
  nextLine: (offset: number) => number,
): SourceAnnotationScan {
  const annotations: SourceAnnotation[] = [];
  const problems: SourceAnnotationProblem[] = [];

  for (const comment of comments) {
    const body = comment.body.trim();
    if (!body.startsWith(PREFIX)) continue;

    const where = `${filePath}:${comment.line}`;
    const parsed = parseDirective(body.slice(PREFIX.length), where);
    if (!parsed.ok) {
      problems.push(parsed.problem);
      continue;
    }

    if (nextLine(comment.end) !== comment.line + 1) {
      problems.push({
        path: where,
        message: 'directive must sit directly above the statement it annotates',
      });
      continue;
    }

    annotations.push({ line: comment.line, annotation: parsed.annotation });
  }

  return { annotations, problems };
}

type ParsedDirective =
  | { readonly ok: true; readonly annotation: Annotation }
  | { readonly ok: false; readonly problem: SourceAnnotationProblem };

/** `confidence=low main.ts:run calls util.ts:help` after the prefix. */
function parseDirective(rest: string, where: string): ParsedDirective {
  const fields = rest.trim().split(/\s+/);
  if (fields.length !== 4) {
    return fail(where, 'expected confidence=<level> <from> <type> <to>');
  }

  const [confidenceField, from, type, to] = fields as [string, string, string, string];
  const confidence = confidenceField.startsWith(CONFIDENCE_PREFIX)
    ? confidenceField.slice(CONFIDENCE_PREFIX.length)
    : undefined;
  if (!CONFIDENCES.includes(confidence ?? '')) {
    return fail(`${where}:confidence`, 'must be one of high, medium, low');
  }

  if (!RELATIONSHIP_TYPES.has(type)) {
    return fail(`${where}:type`, `"${type}" is not a relationship type`);
  }

  return {
    ok: true,
    annotation: {
      type: type as Annotation['type'],
      from,
      to,
      confidence: confidence as Annotation['confidence'],
    },
  };
}

function fail(path: string, message: string): ParsedDirective {
  return { ok: false, problem: { path, message } };
}

/** One file's directives, with the owner each directive's statement has in that file. */
export interface AnnotatedFile {
  readonly filePath: string;
  readonly scan: SourceAnnotationScan;
  /** The owner a directive must name for the statement on a 1-based line, or the file at top level. */
  readonly ownerOfLine: (line: number) => string;
}

export interface SourceAnnotationResult {
  /** Accepted directives, with source comments already overriding config for the same edge. */
  readonly annotations: readonly Annotation[];
  readonly problems: readonly AnnotationProblem[];
}

/**
 * Accepts the directives every language found, then merges them with the config annotations. A
 * directive is accepted only when its `from` is the owner of the statement it sits above, so a
 * comment cannot annotate an edge elsewhere in the file. Where a source directive and a config
 * annotation name the same edge, the source directive wins.
 */
export function collectAnnotations(
  files: readonly AnnotatedFile[],
  configAnnotations: readonly Annotation[],
): SourceAnnotationResult {
  const problems: AnnotationProblem[] = [];
  const bySource = new Map<string, Annotation>();

  for (const file of files) {
    for (const problem of file.scan.problems) {
      problems.push({ path: problem.path, message: problem.message });
    }
    for (const { line, annotation } of file.scan.annotations) {
      const owner = file.ownerOfLine(line);
      if (annotation.from !== owner) {
        problems.push({
          path: `${file.filePath}:${line}`,
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
