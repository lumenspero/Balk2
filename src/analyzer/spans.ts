import * as ts from 'typescript';
import type { SourceSpan } from '../types.js';

/** The 1-based source range of a node, for attaching to relationships. */
export function spanOf(node: ts.Node, filePath: string): SourceSpan {
  const sourceFile = node.getSourceFile();
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    filePath,
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

/** The source text of a node on one line, shortened for use as an observation's subject. */
export function snippetOf(node: ts.Node, maxLength = 80): string {
  const text = node.getText(node.getSourceFile()).replace(/\s+/g, ' ');
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
