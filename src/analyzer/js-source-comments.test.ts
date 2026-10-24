import { describe, expect, it } from 'vitest';
import { scanSourceAnnotations } from './js-source-comments.js';
import type { SourceAnnotationScan } from './source-annotation-engine.js';

const scan = (text: string): SourceAnnotationScan => scanSourceAnnotations('main.ts', text);

describe('source annotation directives', () => {
  it('reads a complete directive as an annotation with its source, type and target', () => {
    const result = scan('// balk2: confidence=low main.ts:run calls util.ts:help\n');
    expect(result.problems).toEqual([]);
    expect(result.annotations).toEqual([
      {
        line: 1,
        annotation: {
          type: 'calls',
          from: 'main.ts:run',
          to: 'util.ts:help',
          confidence: 'low',
        },
      },
    ]);
  });

  it('ignores ordinary comments', () => {
    const result = scan('// just a note about run\nexport function run() {}\n');
    expect(result).toEqual({ annotations: [], problems: [] });
  });

  it('ignores block comments and text inside strings', () => {
    const result = scan(
      '/* balk2: confidence=low main.ts:run calls util.ts:help */\n' +
        "const s = '// balk2: confidence=low main.ts:run calls util.ts:help';\n",
    );
    expect(result).toEqual({ annotations: [], problems: [] });
  });

  it('rejects an unknown confidence value', () => {
    const result = scan('// balk2: confidence=certain main.ts:run calls util.ts:help\n');
    expect(result.annotations).toEqual([]);
    expect(result.problems.map((p) => p.path)).toEqual(['main.ts:1:confidence']);
  });

  it('rejects a directive with the wrong number of fields', () => {
    const result = scan('// balk2: confidence=low main.ts:run calls\n');
    expect(result.annotations).toEqual([]);
    expect(result.problems.map((p) => p.path)).toEqual(['main.ts:1']);
  });

  it('rejects an unknown relationship type', () => {
    const result = scan('// balk2: confidence=low main.ts:run flies util.ts:help\n');
    expect(result.annotations).toEqual([]);
    expect(result.problems.map((p) => p.path)).toEqual(['main.ts:1:type']);
  });
});

describe('source annotation placement', () => {
  it('applies a directive to the statement directly below it', () => {
    const result = scan(
      '// balk2: confidence=low main.ts:run calls util.ts:help\nexport const x = help();\n',
    );
    expect(result.annotations[0]?.line).toBe(1);
    expect(result.annotations[0]?.annotation.from).toBe('main.ts:run');
  });

  it('keeps a directive that is separated from its statement by a blank line', () => {
    const result = scan('// balk2: confidence=low main.ts:run calls util.ts:help\n\nrun();\n');
    expect(result.problems.map((p) => p.path)).toEqual(['main.ts:1']);
    expect(result.annotations).toEqual([]);
  });
});
