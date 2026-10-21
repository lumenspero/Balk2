import type { SyntaxErrorNote } from '../repository-program.js';
import { parseModuleRecovering } from './statement-parser.js';

/** The syntax problems in one Python file, in the shape the graph reports for every language. */
export function pythonSyntaxNotes(path: string, source: string): SyntaxErrorNote[] {
  return parseModuleRecovering(source).errors.map((error) => ({
    path,
    line: error.line,
    column: error.column,
    message: error.message,
  }));
}
