import * as ts from 'typescript';
import {
  readDirectives,
  type FoundComment,
  type SourceAnnotationScan,
} from './source-annotation-engine.js';

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
