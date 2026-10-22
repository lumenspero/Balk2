import type { SyntaxErrorNote } from '../repository-program.js';
import { parseRustFile } from './items.js';

/**
 * The syntax problems in one Rust file, in the shape the graph reports for every language.
 * `parseRustFile` reports lexer, token-tree and item errors together, already in source order.
 */
export function rustSyntaxNotes(path: string, source: string): SyntaxErrorNote[] {
  return parseRustFile(source).errors.map((error) => ({
    path,
    line: error.line,
    column: error.column,
    message: error.message,
  }));
}
