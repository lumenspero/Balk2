import { describe, expect, it } from 'vitest';
import { lexRust } from './lexer.js';
import { buildTokenTrees, isTokenGroup, type TokenGroup } from './token-tree.js';

function groupsOf(source: string, expressionMacros?: readonly string[]): TokenGroup[] {
  const { trees } = buildTokenTrees(
    lexRust(source).tokens,
    expressionMacros ? { expressionMacros: new Set(expressionMacros) } : {},
  );
  return trees.filter(isTokenGroup);
}

describe('configured expression macros (V3 Phase 15.3)', () => {
  it('marks the argument group of a configured macro as code', () => {
    const [args] = groupsOf('log_info!(helper());', ['log_info']);
    expect(args?.codeArguments).toBe(true);
  });

  it('does not mark a macro that is not configured', () => {
    const [args] = groupsOf('other!(helper());', ['log_info']);
    expect(args?.codeArguments).toBeUndefined();
  });

  it('marks nothing without a configured list', () => {
    const [args] = groupsOf('log_info!(helper());');
    expect(args?.codeArguments).toBeUndefined();
  });

  it('marks only the group that follows the name and the bang', () => {
    const groups = groupsOf('log_info!(a); (b);', ['log_info']);
    expect(groups.map((g) => g.codeArguments)).toEqual([true, undefined]);
  });
});
