import type { SyntaxErrorNote } from '../repository-program.js';
import { lexRust } from './lexer.js';
import { buildTokenTrees } from './token-tree.js';

/** The syntax problems in one Rust file, in the shape the graph reports for every language. */
export function rustSyntaxNotes(path: string, source: string): SyntaxErrorNote[] {
  const lexed = lexRust(source);
  const { errors: treeErrors } = buildTokenTrees(lexed.tokens);
  return [...lexed.errors, ...treeErrors]
    .sort((a, b) => a.line - b.line || a.column - b.column)
    .map((error) => ({ path, line: error.line, column: error.column, message: error.message }));
}
