import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildConnectionGraphDetailed } from '../../../cli/build-graph.js';

/**
 * The macro fixture (V3 Phase 10): macro invocations, expression-style arguments, and an item
 * that only a macro generates. Balk2 does not expand macros, so the generated item must have
 * no node and no edge.
 */

const FIXTURE = fileURLToPath(new URL('../../../../test/fixtures/cargo-macros', import.meta.url));

describe('macro fixture (V3 Phase 10)', () => {
  const built = buildConnectionGraphDetailed(FIXTURE);
  const relationships = built.graph.getRelationships();

  it('draws calls for invocations, expression-style arguments and crate:: macro paths', () => {
    const calls = relationships
      .filter((rel) => rel.type === 'calls')
      .map((rel) => `${rel.from} -> ${rel.to}`)
      .sort();
    expect(calls).toEqual(
      [
        'src/lib.rs -> src/lib.rs:make_counter!',
        'src/lib.rs:run -> src/lib.rs:exported_value!',
        'src/lib.rs:run -> src/lib.rs:helper_inside_macro',
        'src/lib.rs:run -> src/lib.rs:twice!',
      ].sort(),
    );
  });

  it('creates no node or edge for the function that only make_counter! generates', () => {
    expect(built.graph.hasSymbol('src/lib.rs:generated_counter')).toBe(false);
    const mentions = relationships.filter(
      (rel) => rel.from.includes('generated_counter') || rel.to.includes('generated_counter'),
    );
    expect(mentions).toEqual([]);
    expect(built.problems).toEqual([]);
    expect(built.moduleTree.unresolved).toEqual([]);
  });
});
