import { describe, expect, it } from 'vitest';
import { analyzePythonReferences, type ReferenceAnalysis } from './references.js';
import { createImportResolver } from './modules/import-resolution.js';
import { createSymbolResolver } from './modules/module-exports.js';
import { ModuleIndex } from './modules/module-index.js';

function run(files: Record<string, string>): ReferenceAnalysis {
  const index = new ModuleIndex(Object.keys(files));
  const readText = (p: string): string => files[p] ?? '';
  const imports = createImportResolver(index, { roots: ['.'], readText });
  const symbols = createSymbolResolver({ resolver: imports, readText });
  return analyzePythonReferences(
    Object.entries(files).map(([filePath, source]) => ({ filePath, source })),
    { symbols, imports },
  );
}

/** One line per reference: `owner -> target`, with `<module>` for module-level code. */
function refs(r: ReferenceAnalysis): string[] {
  return r.references.map(
    (ref) =>
      `${ref.owner ?? '<module>'} -> ${ref.target.kind === 'symbol' ? ref.target.id : ref.target.kind}`,
  );
}

describe('python references (5.6)', () => {
  it('references classes named in parameter and return annotations, owned by the module', () => {
    const src = 'class User:\n    pass\ndef f(u: User) -> User:\n    pass\n';
    expect(refs(run({ 'm.py': src }))).toEqual(['<module> -> m.py:User', '<module> -> m.py:User']);
  });

  it('references classes in a subscript or union annotation', () => {
    const src =
      'from typing import Optional\nclass A:\n    pass\ndef f(a: Optional[A] = None, b: "A | None" = None):\n    pass\n';
    expect(refs(run({ 'm.py': src }))).toEqual(['<module> -> m.py:A', '<module> -> m.py:A']);
  });

  it('owns a method parameter annotation by its class, and resolves a string forward reference', () => {
    const src = 'class C:\n    def m(self, other: "C") -> "C":\n        pass\n';
    expect(refs(run({ 'm.py': src }))).toEqual(['m.py:C -> m.py:C', 'm.py:C -> m.py:C']);
  });

  it('does not treat the strings inside Literal as references', () => {
    const src = 'from typing import Literal\nclass A:\n    pass\nx: Literal["A"] = "A"\n';
    expect(refs(run({ 'm.py': src }))).toEqual([]);
  });

  it('references only the first argument of Annotated', () => {
    const src =
      'from typing import Annotated\nclass A:\n    pass\nclass M:\n    pass\nx: Annotated[A, M] = None\n';
    expect(refs(run({ 'm.py': src }))).toEqual(['<module> -> m.py:A']);
  });

  it('emits nothing for an unresolved external annotation', () => {
    const src = 'from typing import List\ndef f(x: List[int]) -> int:\n    return 0\n';
    expect(refs(run({ 'm.py': src }))).toEqual([]);
  });

  it('references a base class', () => {
    const src = 'class B:\n    pass\nclass A(B):\n    pass\n';
    expect(refs(run({ 'm.py': src }))).toEqual(['<module> -> m.py:B']);
  });

  it('references the classes in an isinstance tuple, owned by the function', () => {
    const src = 'class A:\n    pass\ndef f(x):\n    return isinstance(x, (A, int))\n';
    expect(refs(run({ 'm.py': src }))).toEqual(['m.py:f -> m.py:A']);
  });

  it('references the classes in an except tuple', () => {
    const src =
      'class E(Exception):\n    pass\ndef f():\n    try:\n        pass\n    except (E, ValueError):\n        pass\n';
    expect(refs(run({ 'm.py': src }))).toEqual(['m.py:f -> m.py:E']);
  });

  it('references the class of a match class pattern', () => {
    const src =
      'class Circle:\n    pass\ndef f(s):\n    match s:\n        case Circle():\n            pass\n';
    expect(refs(run({ 'm.py': src }))).toEqual(['m.py:f -> m.py:Circle']);
  });

  it('owns a dataclass field annotation by the field, not the class', () => {
    const src =
      'from dataclasses import dataclass\n@dataclass\nclass U:\n    other: "V"\nclass V:\n    pass\n';
    expect(refs(run({ 'm.py': src }))).toEqual(['m.py:U.other -> m.py:V']);
  });
});
