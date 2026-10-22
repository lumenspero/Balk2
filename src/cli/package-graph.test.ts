import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Balk2Config } from '../config/balk2-config.js';
import { type BuiltGraph, buildConnectionGraphDetailed } from './build-graph.js';
import type { ConnectionMap } from '../types.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url));

function build(name: string, config?: Balk2Config): { built: BuiltGraph; map: ConnectionMap } {
  const built = buildConnectionGraphDetailed(fixture(name), config);
  const map = built.graph.build({ commit: 'test', generatedAt: '2026-01-01T00:00:00Z' });
  return { built, map };
}

describe('package facts in the connection map (V3 Phase 7.5 wiring)', () => {
  it('emits npm packages, packageRoot and dependsOn edges for the npm workspace fixture', () => {
    const { built, map } = build('npm-workspaces');
    expect(built.manifestProblems).toEqual([]);
    expect(Object.keys(map.packages)).toEqual([
      'package:npm:.',
      'package:npm:packages/app',
      'package:npm:packages/core',
      'package:npm:packages/util',
      'package:npm:tools/cli',
    ]);
    // dist/ is excluded by the scan, so its entries are neither roots nor problems.
    const roots = map.relationships.filter((r) => r.type === 'packageRoot');
    expect(roots).toHaveLength(6);
    const depends = map.relationships
      .filter((r) => r.type === 'dependsOn')
      .map((r) => [r.from, r.to, r.metadata?.kind]);
    expect(depends).toEqual([
      ['package:npm:.', 'package:npm:packages/core', 'dev'],
      ['package:npm:packages/app', 'package:npm:packages/core', 'normal'],
      ['package:npm:packages/app', 'package:npm:packages/util', 'normal'],
      ['package:npm:tools/cli', 'package:npm:packages/core', 'peer'],
    ]);
  });

  it('emits python packages, script roots, dependsOn and entry-point registrations', () => {
    const config: Balk2Config = { version: 2, python: { roots: ['apps/cli', 'libs/core'] } };
    const { built, map } = build('python-packages', config);
    expect(built.manifestProblems).toEqual([]);
    expect(Object.keys(map.packages)).toEqual([
      'package:python:apps/cli',
      'package:python:apps/cli#script:acme',
      'package:python:libs/core',
    ]);
    expect(map.packages['package:python:apps/cli#script:acme']?.roots).toEqual([
      'apps/cli/acme_cli/main.py',
    ]);
    expect(
      map.relationships.filter((r) => r.type === 'packageRoot').map((r) => [r.from, r.to]),
    ).toEqual([['package:python:apps/cli#script:acme', 'apps/cli/acme_cli/main.py']]);
    expect(
      map.relationships
        .filter((r) => r.type === 'dependsOn')
        .map((r) => [r.from, r.to, r.metadata?.kind]),
    ).toEqual([['package:python:apps/cli', 'package:python:libs/core', 'normal']]);
    expect(map.relationships.filter((r) => r.type === 'registers').map((r) => r.to)).toEqual([
      'libs/core/acme_core/__init__.py:helper',
    ]);
  });
});
