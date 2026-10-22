import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type NpmPackageDiscovery, discoverNpmPackages } from './npm-packages.js';

const fixture = fileURLToPath(new URL('../../test/fixtures/npm-workspaces', import.meta.url));

function listFiles(root: string, dir = ''): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
    return entry.isDirectory() ? listFiles(root, path) : [path];
  });
}

function discover(files: Record<string, string>): NpmPackageDiscovery {
  return discoverNpmPackages(Object.keys(files), (path) => files[path] ?? '');
}

describe('discoverNpmPackages on the npm-workspaces fixture', () => {
  const result = discoverNpmPackages(listFiles(fixture), (path) =>
    readFileSync(join(fixture, path), 'utf8'),
  );

  it('emits one package node per named package, with entries as roots', () => {
    expect(result.packages.map((p) => [p.id, p.name, p.roots, p.manifest])).toEqual([
      ['package:npm:.', 'monorepo-root', [], 'package.json'],
      [
        'package:npm:packages/app',
        '@acme/app',
        ['packages/app/bin/app.js'],
        'packages/app/package.json',
      ],
      [
        'package:npm:packages/core',
        '@acme/core',
        [
          'packages/core/dist/index.cjs',
          'packages/core/dist/index.js',
          'packages/core/src/index.d.ts',
          'packages/core/src/utils.js',
        ],
        'packages/core/package.json',
      ],
      [
        'package:npm:packages/util',
        '@acme/util',
        ['packages/util/src/numbers.js', 'packages/util/src/strings.js'],
        'packages/util/package.json',
      ],
      ['package:npm:tools/cli', 'acme-cli', ['tools/cli/bin/acme.js'], 'tools/cli/package.json'],
    ]);
    expect(result.packages.every((p) => p.ecosystem === 'npm' && p.kind === 'package')).toBe(true);
  });

  it('draws dependsOn edges only for satisfied ranges and workspace: specs', () => {
    expect(result.dependencies.map((d) => [d.from, d.to, d.kind, d.name])).toEqual([
      ['package:npm:.', 'package:npm:packages/core', 'dev', '@acme/core'],
      ['package:npm:packages/app', 'package:npm:packages/core', 'normal', '@acme/core'],
      ['package:npm:packages/app', 'package:npm:packages/util', 'normal', '@acme/util'],
      ['package:npm:tools/cli', 'package:npm:packages/core', 'peer', '@acme/core'],
    ]);
  });

  it('reports no problems for the clean fixture', () => {
    expect(result.problems).toEqual([]);
  });
});

describe('discoverNpmPackages', () => {
  it('skips package.json files under node_modules', () => {
    const result = discover({
      'package.json': '{"name":"root"}',
      'node_modules/left-pad/package.json': '{"name":"left-pad"}',
    });
    expect(result.packages.map((p) => p.id)).toEqual(['package:npm:.']);
  });

  it('reports invalid JSON and emits no node for that manifest', () => {
    const result = discover({ 'packages/a/package.json': '{' });
    expect(result.packages).toEqual([]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.path).toBe('packages/a/package.json');
    expect(result.problems[0]?.message).toMatch(/^package\.json is not valid JSON/);
  });

  it('draws no dependency edges outside a workspace', () => {
    const result = discover({
      'package.json': '{"name":"a","dependencies":{"b":"^1.0.0"}}',
      'b/package.json': '{"name":"b","version":"1.0.0"}',
    });
    expect(result.packages).toHaveLength(2);
    expect(result.dependencies).toEqual([]);
  });

  it('reports a workspace glob that matches no package', () => {
    const result = discover({
      'package.json': '{"name":"root","workspaces":["packages/missing/*"]}',
    });
    expect(result.problems).toEqual([
      { path: 'package.json', message: 'workspace "packages/missing/*" matches no package' },
    ]);
  });

  it('removes negated matches from the workspace', () => {
    const result = discover({
      'package.json': '{"workspaces":["packages/*","!packages/skip"]}',
      'packages/keep/package.json': '{"name":"keep","dependencies":{"skip":"^1.0.0"}}',
      'packages/skip/package.json': '{"name":"skip","version":"1.0.0"}',
    });
    expect(result.packages.map((p) => p.name)).toEqual(['keep', 'skip']);
    expect(result.dependencies).toEqual([]);
    expect(result.problems).toEqual([]);
  });

  it('reports a workspace: spec that names no workspace package', () => {
    const result = discover({
      'package.json': '{"name":"root","workspaces":["packages/*"]}',
      'packages/a/package.json': '{"name":"a","dependencies":{"ghost":"workspace:*"}}',
    });
    expect(result.dependencies).toEqual([]);
    expect(result.problems).toEqual([
      {
        path: 'packages/a/package.json',
        message:
          'dependency "ghost" uses the workspace protocol but no workspace package is named "ghost"',
      },
    ]);
  });

  it('reports a range it cannot check, and draws no edge for it', () => {
    const result = discover({
      'package.json': '{"name":"root","workspaces":["packages/*"]}',
      'packages/a/package.json': '{"name":"a","dependencies":{"b":">=1.0.0"}}',
      'packages/b/package.json': '{"name":"b","version":"1.0.0"}',
    });
    expect(result.dependencies).toEqual([]);
    expect(result.problems).toEqual([
      {
        path: 'packages/a/package.json',
        message: 'dependency "b" range ">=1.0.0" cannot be checked against workspace package "b"',
      },
    ]);
  });

  it('draws no edge, and no problem, for a range the workspace package does not satisfy', () => {
    const result = discover({
      'package.json': '{"name":"root","workspaces":["packages/*"]}',
      'packages/a/package.json': '{"name":"a","dependencies":{"b":"^2.0.0"}}',
      'packages/b/package.json': '{"name":"b","version":"1.0.0"}',
    });
    expect(result.dependencies).toEqual([]);
    expect(result.problems).toEqual([]);
  });

  it('does not link a package to itself', () => {
    const result = discover({
      'package.json': '{"name":"root","workspaces":["packages/*"]}',
      'packages/a/package.json':
        '{"name":"a","version":"1.0.0","dependencies":{"a":"workspace:*"}}',
    });
    expect(result.dependencies).toEqual([]);
    expect(result.problems).toEqual([]);
  });

  it('draws edges between members of a root that has no name', () => {
    const result = discover({
      'package.json': '{"workspaces":["packages/*"]}',
      'packages/a/package.json':
        '{"name":"a","version":"1.0.0","dependencies":{"b":"workspace:*"}}',
      'packages/b/package.json': '{"name":"b","version":"1.0.0"}',
    });
    expect(result.packages.map((p) => p.name)).toEqual(['a', 'b']);
    expect(result.dependencies.map((d) => [d.from, d.to])).toEqual([
      ['package:npm:packages/a', 'package:npm:packages/b'],
    ]);
  });

  it('resolves main without its extension and reports a main that does not exist', () => {
    const resolved = discover({
      'pkg/package.json': '{"name":"pkg","main":"./lib"}',
      'pkg/lib.js': '',
    });
    expect(resolved.packages[0]?.roots).toEqual(['pkg/lib.js']);

    const missing = discover({ 'pkg/package.json': '{"name":"pkg","main":"dist/index.js"}' });
    expect(missing.packages[0]?.roots).toEqual([]);
    expect(missing.problems).toEqual([
      { path: 'pkg/package.json', message: 'main entry "dist/index.js" has no source file' },
    ]);
  });

  it('reads bin as a string or as a map of names to files', () => {
    const result = discover({
      'pkg/package.json': '{"name":"pkg","bin":{"one":"./bin/one.js","two":"./bin/two.js"}}',
      'pkg/bin/one.js': '',
      'pkg/bin/two.js': '',
    });
    expect(result.packages[0]?.roots).toEqual(['pkg/bin/one.js', 'pkg/bin/two.js']);
    expect(result.problems).toEqual([]);
  });

  it('does not report an entry that exists on disk but was not scanned', () => {
    const result = discoverNpmPackages(
      ['pkg/package.json'],
      () =>
        '{"name":"pkg","main":"dist/index.js","exports":{".":"./dist/index.js","./x":"./dist/*.js"}}',
      (path) => path === 'pkg/dist/index.js' || path === 'pkg/dist',
    );
    expect(result.problems).toEqual([]);
    expect(result.packages[0]?.roots).toEqual([]);
  });

  it('expands exports patterns and reports a pattern that matches nothing', () => {
    const matched = discover({
      'pkg/package.json': '{"name":"pkg","exports":{"./*":"./src/*.js"}}',
      'pkg/src/a.js': '',
      'pkg/src/b.js': '',
    });
    expect(matched.packages[0]?.roots).toEqual(['pkg/src/a.js', 'pkg/src/b.js']);

    const unmatched = discover({ 'pkg/package.json': '{"name":"pkg","exports":"./out/*.js"}' });
    expect(unmatched.problems).toEqual([
      { path: 'pkg/package.json', message: 'exports entry "./out/*.js" has no source file' },
    ]);
  });

  it('reports workspaces that are neither an array nor an object with packages', () => {
    const result = discover({ 'package.json': '{"name":"root","workspaces":"packages/*"}' });
    expect(result.problems).toEqual([
      { path: 'package.json', message: 'workspaces must be an array of package globs' },
    ]);
  });
});
