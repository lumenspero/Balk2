import { describe, expect, it } from 'vitest';
import { buildMap } from '../testing/connection-map-builder.js';
import type { UnresolvedReferenceNode } from '../types.js';
import { collectDiagnostics, DIAGNOSTIC_KINDS, failureLines, parseFailOn } from './diagnostics.js';

const unresolved = (
  id: string,
  reason: UnresolvedReferenceNode['reason'],
  filePath: string,
  line: number,
  extra: Partial<UnresolvedReferenceNode> = {},
): UnresolvedReferenceNode => ({
  kind: 'unresolved-reference',
  id,
  reason,
  attempted: 'emits',
  subject: 'Foo',
  location: { filePath, startLine: line, startColumn: 1, endLine: line, endColumn: 5 },
  ...extra,
});

function mapWithUnresolved(nodes: UnresolvedReferenceNode[]) {
  const map = buildMap({ files: ['src/a.ts'] }, []);
  return {
    ...map,
    unresolved: Object.fromEntries(nodes.map((node) => [node.id, node])),
  };
}

describe('parseFailOn', () => {
  it('accepts a comma-separated list and removes duplicates', () => {
    expect(parseFailOn('syntax, ambiguous-global,syntax')).toEqual(['syntax', 'ambiguous-global']);
  });

  it('rejects an empty list', () => {
    expect(() => parseFailOn(' , ')).toThrow('--fail-on needs at least one kind');
  });

  it('names an unknown kind and lists the valid ones', () => {
    expect(() => parseFailOn('bogus')).toThrow('--fail-on: unknown kind "bogus"');
    expect(() => parseFailOn('bogus')).toThrow('ambiguous-global');
  });

  it('accepts every kind the diagnostics can report', () => {
    expect(parseFailOn(DIAGNOSTIC_KINDS.join(','))).toHaveLength(DIAGNOSTIC_KINDS.length);
  });
});

describe('collectDiagnostics', () => {
  const map = mapWithUnresolved([
    unresolved('u1', 'ambiguous-global', 'src/b.ts', 3, { detail: 'two candidates' }),
    unresolved('u2', 'dynamic-event-name', 'src/a.ts', 9, { tier: 'internal' }),
  ]);

  it('reports config, syntax, and actionable unresolved references in a fixed order', () => {
    const found = collectDiagnostics(
      map,
      [{ path: 'protocols.events', message: 'ignored' }],
      [{ path: 'src/a.ts', line: 1, column: 2, message: 'bad token' }],
    );
    expect(found.map((d) => `${d.kind}@${d.path}`)).toEqual([
      'config@.balk2.json',
      'syntax@src/a.ts',
      'ambiguous-global@src/b.ts',
    ]);
  });

  it('leaves out internal unresolved references', () => {
    const found = collectDiagnostics(map, [], []);
    expect(found.map((d) => d.kind)).not.toContain('dynamic-event-name');
  });

  it('includes the detail with the subject when there is one', () => {
    const found = collectDiagnostics(map, [], []);
    expect(found[0]?.message).toBe('Foo: two candidates');
  });

  it('gives the same order no matter the order the inputs arrive in', () => {
    const reversed = mapWithUnresolved(
      [
        ...[
          unresolved('u1', 'ambiguous-global', 'src/b.ts', 3),
          unresolved('u3', 'dynamic-state-path', 'src/a.ts', 2),
        ],
      ].reverse(),
    );
    const forward = mapWithUnresolved([
      unresolved('u3', 'dynamic-state-path', 'src/a.ts', 2),
      unresolved('u1', 'ambiguous-global', 'src/b.ts', 3),
    ]);
    expect(collectDiagnostics(reversed, [], [])).toEqual(collectDiagnostics(forward, [], []));
  });
});

describe('failureLines', () => {
  const found = collectDiagnostics(
    mapWithUnresolved([unresolved('u1', 'ambiguous-global', 'src/b.ts', 3)]),
    [{ path: 'x', message: 'ignored' }],
    [{ path: 'src/a.ts', line: 1, column: 2, message: 'bad token' }],
  );

  it('prints only the selected kinds, with a summary', () => {
    expect(failureLines(found, ['syntax'])).toEqual([
      'balk2 diagnostic [syntax]: src/a.ts:1:2: bad token',
      'balk2: 1 diagnostic matched --fail-on (syntax)',
    ]);
  });

  it('prints nothing when no selected kind is present', () => {
    expect(failureLines(found, ['dynamic-resource-specifier'])).toEqual([]);
  });

  it('pluralizes the summary when several match', () => {
    const lines = failureLines(found, ['syntax', 'config']);
    expect(lines.at(-1)).toBe('balk2: 2 diagnostics matched --fail-on (syntax, config)');
  });
});
