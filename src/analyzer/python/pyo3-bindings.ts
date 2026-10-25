import type { SourceSpan } from '../../types.js';
import type { BindingConsumer, FrontEndBindings } from '../bindings/types.js';
import type { Span } from './ast.js';
import { parseModuleRecovering } from './statement-parser.js';

/**
 * The Python side of the PyO3 bindings (V3 Phase 14.3). Each `from module import name` at the top
 * of a file is a consumer. It matches only a `#[pymodule]` member of a crate that depends on
 * `pyo3`. Relative imports and `import module` are not bound in this phase.
 */
export function pythonPyo3Bindings(
  files: readonly { readonly filePath: string; readonly source: string }[],
): FrontEndBindings {
  const consumers: BindingConsumer[] = [];
  for (const file of files) {
    for (const stmt of parseModuleRecovering(file.source).body) {
      if (stmt.kind !== 'importfrom' || stmt.level !== 0 || stmt.module === null) continue;
      if (stmt.names === 'star') continue;
      for (const alias of stmt.names) {
        consumers.push({
          kind: 'pyo3',
          side: 'python',
          specifier: stmt.module,
          name: alias.name,
          file: file.filePath,
          span: spanOf(stmt.span, file.filePath),
        });
      }
    }
  }
  return { exports: [], consumers };
}

function spanOf(span: Span, file: string): SourceSpan {
  return {
    filePath: file,
    startLine: span.line,
    startColumn: span.column,
    endLine: span.endLine,
    endColumn: span.endColumn,
  };
}
