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
 * A string that names a data file: no whitespace, a basename before the extension (so `.json`
 * alone does not count), and a recognized data extension.
 */
export function isDataPathLiteral(text: string): boolean {
  return !/\s/.test(text) && /[^./\\]\.[A-Za-z0-9]+$/.test(text) && isDataArtifact(text);
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
