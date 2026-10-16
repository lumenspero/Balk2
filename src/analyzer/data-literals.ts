import * as ts from 'typescript';
import { isDataArtifact } from '../data/formats.js';

/** String methods whose arguments are text being searched or changed, not a file being opened. */
const STRING_METHODS: ReadonlySet<string> = new Set([
  'endsWith',
  'startsWith',
  'includes',
  'indexOf',
  'lastIndexOf',
  'replace',
  'replaceAll',
  'split',
  'match',
  'matchAll',
  'search',
  'test',
  'padStart',
  'padEnd',
  'slice',
  'substring',
  'localeCompare',
]);

/** Path helpers only assemble a path. Whatever receives the result is what opens the file. */
const PATH_BUILDERS: ReadonlySet<string> = new Set(['join', 'resolve']);

const EQUALITY_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

/**
 * Text before a literal that means the literal is searched or compared: an open string-method call
 * such as `name.endswith(`, or a comparison such as `mode == `. Case-insensitive, so the same check
 * serves Python's snake_case method names.
 */
const NON_ACCESS_BEFORE = new RegExp(
  `(?:\\.(?:${[...STRING_METHODS].join('|')})\\(\\s*|[=!]=\\s*)$`,
  'i',
);

/**
 * A string that names a file in the repository: no whitespace, a basename before the extension (so
 * `.json` alone does not count), a recognized data extension, and not a URL, a web-root path or a
 * template with a placeholder.
 */
export function isDataPathLiteral(text: string): boolean {
  if (/\s/.test(text) || isRemoteOrTemplate(text)) return false;
  return /[^./\\]\.[A-Za-z0-9]+$/.test(text) && isDataArtifact(text);
}

/**
 * A URL, a web-root path such as `/manifest.json` (served by the app, not read from the repo), or a
 * template such as `steamspy_page_{page}.json` (a name that varies at run time).
 */
function isRemoteOrTemplate(text: string): boolean {
  return text.includes('://') || text.startsWith('/') || /[{}]/.test(text);
}

/** True when the literal is searched, compared or changed as text, so it is not a file access. */
export function isNonAccessLiteral(node: ts.Node): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (!parent) return false;

  if (
    ts.isCallExpression(parent) &&
    parent.arguments.some((arg) => arg === node) &&
    ts.isPropertyAccessExpression(parent.expression) &&
    STRING_METHODS.has(parent.expression.name.text)
  ) {
    return true;
  }

  return ts.isBinaryExpression(parent) && EQUALITY_OPERATORS.has(parent.operatorToken.kind);
}

/**
 * The line-based version of {@link isNonAccessLiteral}, for analyzers without a syntax tree. Pass
 * the source text that comes before the literal on its line.
 */
export function isNonAccessBefore(textBeforeLiteral: string): boolean {
  return NON_ACCESS_BEFORE.test(textBeforeLiteral);
}

const QUOTED_SOURCE = `'[^']+'|"[^"]+"`;
const QUOTED_PIECE = /(?:'([^']+)'|"([^"]+)")/g;
/** Quoted pieces joined with `/`, as in `root / "data" / "targets" / "x.json"` (pathlib). */
const SLASH_CHAIN = new RegExp(`(?:${QUOTED_SOURCE})(?:\\s*\\/\\s*(?:${QUOTED_SOURCE}))+`, 'g');
/** A path join call, as in `os.path.join(base, "data", "x.json")`. */
const JOIN_CALL = /\b(?:os\.path\.join|posixpath\.join|path\.join)\s*\(([^()]*)\)/g;

/** A string literal found on a line, and where it starts. */
export interface LinePathLiteral {
  readonly value: string;
  readonly index: number;
}

/**
 * The string literals on a line that may name a file, for analyzers without a syntax tree. Pieces
 * joined into one path, by `/` or by a join call, are reported once as the full relative path.
 * Their individual pieces are not reported, so `"x.json"` does not appear alone when its directory
 * is known. A join whose pieces are all unquoted (`os.path.join(base, name)`) reports nothing.
 */
export function pathLiteralsInLine(line: string): LinePathLiteral[] {
  const found: LinePathLiteral[] = [];
  const spans: Array<readonly [number, number]> = [];

  const addJoined = (text: string, index: number): void => {
    const pieces = [...text.matchAll(QUOTED_PIECE)].map((m) => m[1] ?? m[2] ?? '');
    if (pieces.length === 0) return;
    found.push({ value: pieces.join('/'), index });
    spans.push([index, index + text.length]);
  };

  for (const m of line.matchAll(SLASH_CHAIN)) addJoined(m[0], m.index ?? 0);
  for (const m of line.matchAll(JOIN_CALL)) addJoined(m[0], m.index ?? 0);

  for (const m of line.matchAll(QUOTED_PIECE)) {
    const index = m.index ?? 0;
    if (spans.some(([start, end]) => index >= start && index < end)) continue;
    found.push({ value: m[1] ?? m[2] ?? '', index });
  }
  return found;
}

/**
 * The source text that says what a literal's file is used for. Path helpers are looked through,
 * so `fs.writeFileSync(path.join(dir, 'out.json'), data)` is judged by `writeFileSync`.
 */
export function accessContext(node: ts.Node, sourceFile: ts.SourceFile): string {
  let current: ts.Node = node;
  while (current.parent && isPathBuilderCall(current.parent)) {
    current = current.parent;
  }
  const context = current.parent ?? current;
  return context.getText(sourceFile);
}

function isPathBuilderCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return ts.isPropertyAccessExpression(callee) && PATH_BUILDERS.has(callee.name.text);
}
