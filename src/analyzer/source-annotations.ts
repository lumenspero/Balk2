import * as ts from 'typescript';
import type { Annotation } from './annotations.js';

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
 * Read `// balk2: confidence=<level> <from> <type> <to>` directives from a TypeScript or JavaScript
 * file. Only `//` line comments are read; block comments and text inside strings are never
 * directives.
 */
export function scanSourceAnnotations(filePath: string, text: string): SourceAnnotationScan {
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindOf(filePath),
  );

  // Leading trivia of every node holds the comments before it. Deduplicate by position, since a
  // parent and its first child share one.
  const comments = new Map<number, ts.CommentRange>();
  const visit = (node: ts.Node): void => {
    for (const range of ts.getLeadingCommentRanges(text, node.pos) ?? []) {
      comments.set(range.pos, range);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const found: FoundComment[] = [...comments.values()]
    .filter((range) => range.kind === ts.SyntaxKind.SingleLineCommentTrivia)
    .sort((a, b) => a.pos - b.pos)
    .map((range) => ({
      body: text.slice(range.pos + 2, range.end),
      line: sourceFile.getLineAndCharacterOfPosition(range.pos).line + 1,
      end: range.end,
    }));

  return readDirectives(filePath, found, (from) => nextTokenLine(text, from));
}

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

/**
 * The 1-based line of the first token after `from`, skipping whitespace and comments. A position
 * at the end of the file counts as the last line.
 */
function nextTokenLine(text: string, from: number): number {
  let pos = from;
  while (pos < text.length) {
    if (/\s/.test(text[pos] ?? '')) {
      pos++;
    } else if (text.startsWith('//', pos)) {
      const newline = text.indexOf('\n', pos);
      pos = newline < 0 ? text.length : newline + 1;
    } else if (text.startsWith('/*', pos)) {
      const close = text.indexOf('*/', pos + 2);
      pos = close < 0 ? text.length : close + 2;
    } else {
      break;
    }
  }
  return lineOf(text, pos);
}

/** The 1-based line containing a character offset. */
function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

function scriptKindOf(filePath: string): ts.ScriptKind {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (lower.endsWith('.ts')) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}
