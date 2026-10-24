import { describe, expect, it } from 'vitest';
import { scanPythonSourceAnnotations } from './python-source-comments.js';
import type { SourceAnnotationScan } from './source-annotation-engine.js';

const scan = (text: string): SourceAnnotationScan => scanPythonSourceAnnotations('app.py', text);

describe('python source directives', () => {
  it('reads a # directive above a statement as an annotation', () => {
    const result = scan(
      'def run():\n    # balk2: confidence=low app.py:run calls pkg/util.py:help\n    return help()\n',
    );
    expect(result.problems).toEqual([]);
    expect(result.annotations).toEqual([
      {
        line: 2,
        annotation: {
          type: 'calls',
          from: 'app.py:run',
          to: 'pkg/util.py:help',
          confidence: 'low',
        },
      },
    ]);
  });

  it('ignores a directive-like line inside a string literal', () => {
    const result = scan(
      'DOC = """\n# balk2: confidence=low app.py:run calls pkg/util.py:help\n"""\n',
    );
    expect(result).toEqual({ annotations: [], problems: [] });
  });

  it('reports a directive separated from its statement by a blank line', () => {
    const result = scan(
      'def run():\n    # balk2: confidence=low app.py:run calls pkg/util.py:help\n\n    return help()\n',
    );
    expect(result.annotations).toEqual([]);
    expect(result.problems.map((p) => p.path)).toEqual(['app.py:2']);
  });

  it('reports an unknown confidence value', () => {
    const result = scan(
      'def run():\n    # balk2: confidence=certain app.py:run calls pkg/util.py:help\n    return help()\n',
    );
    expect(result.annotations).toEqual([]);
    expect(result.problems.map((p) => p.path)).toEqual(['app.py:2:confidence']);
  });
});
