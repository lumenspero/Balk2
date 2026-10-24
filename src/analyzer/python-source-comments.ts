import {
  readDirectives,
  type FoundComment,
  type SourceAnnotationScan,
} from './source-annotation-engine.js';

/**
 * Read `# balk2: confidence=<level> <from> <type> <to>` directives from a Python file. Only `#`
 * comments on their own line are read. Lines inside a triple-quoted string are skipped, so a
 * directive-like line in a docstring is text, not a directive.
 */
export function scanPythonSourceAnnotations(filePath: string, text: string): SourceAnnotationScan {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const starts = lineStartOffsets(lines);
  const comments: FoundComment[] = [];

  let quote: string | undefined; // the open triple quote, when inside a string
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    if (quote !== undefined) {
      if (line.includes(quote)) quote = undefined;
      continue;
    }

    if (trimmed.startsWith('#')) {
      comments.push({
        body: trimmed.slice(1),
        line: i + 1,
        end: (starts[i] ?? 0) + line.length,
      });
      continue;
    }

    const opened = openingTripleQuote(line);
    if (opened !== undefined) quote = opened;
  }

  return readDirectives(filePath, comments, (offset) => nextCodeLine(lines, starts, offset));
}

/** The triple quote that a line opens without closing, or undefined. */
function openingTripleQuote(line: string): string | undefined {
  for (const quote of ['"""', "'''"]) {
    const count = line.split(quote).length - 1;
    if (count % 2 === 1) return quote;
  }
  return undefined;
}

function lineStartOffsets(lines: readonly string[]): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return starts;
}

/**
 * The 1-based line of the first code line after the comment that ends at `offset`. Blank lines and
 * comment lines are skipped, matching the JS rule, so a directive is valid only when the code it
 * annotates is on the line directly below it.
 */
function nextCodeLine(lines: readonly string[], starts: readonly number[], offset: number): number {
  // The comment's last character sits at offset - 1; find the line that contains it.
  let commentIndex = 0;
  for (let i = 0; i < starts.length; i++) {
    if ((starts[i] ?? 0) <= offset - 1) commentIndex = i;
  }

  for (let index = commentIndex + 1; index < lines.length; index++) {
    const trimmed = (lines[index] ?? '').trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    return index + 1;
  }
  return lines.length + 1;
}
