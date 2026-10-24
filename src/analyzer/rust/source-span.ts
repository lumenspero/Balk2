import type { SourceSpan } from '../../types.js';
import type { Span } from './items.js';

/** A Rust span as a graph source span: the file, and the 1-based line and column range. */
export function sourceSpanOf(span: Span, filePath: string): SourceSpan {
  return {
    filePath,
    startLine: span.line,
    startColumn: span.column,
    endLine: span.endLine,
    endColumn: span.endColumn,
  };
}
