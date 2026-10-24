import {
  readDirectives,
  type FoundComment,
  type SourceAnnotationScan,
} from '../source-annotation-engine.js';
import { lexRust } from './lexer.js';

/**
 * Read `// balk2:` directives from a Rust file (V3 Phase 12.7). Only `//` line comments are read.
 * Doc comments (`///`, `//!`) and block comments are not directives, and text inside a string is a
 * token, never a comment. The lexer already keeps all of those apart.
 */
export function scanRustSourceComments(filePath: string, text: string): SourceAnnotationScan {
  const { tokens, trivia } = lexRust(text);
  const rawLines = text.split('\n');
  const starts: number[] = [];
  let offset = 0;
  for (const line of rawLines) {
    starts.push(offset);
    offset += line.length + 1;
  }

  const comments: FoundComment[] = trivia
    .filter((item) => item.kind === 'comment' && item.text.startsWith('//'))
    .map((item) => ({
      body: item.text.slice(2),
      line: item.line,
      // A line comment runs to the end of its line.
      end: (starts[item.line - 1] ?? 0) + (rawLines[item.line - 1] ?? '').length,
    }));

  const nextLine = (end: number): number => {
    // The comment's last character sits at end - 1, so its line is the last line that starts before it.
    let commentLine = 1;
    for (let i = 0; i < starts.length; i++) {
      if ((starts[i] ?? 0) <= end - 1) commentLine = i + 1;
    }
    const next = tokens.find((token) => token.line > commentLine);
    return next?.line ?? rawLines.length + 1;
  };

  return readDirectives(filePath, comments, nextLine);
}
