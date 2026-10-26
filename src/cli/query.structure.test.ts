import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConnectionGraph } from '../graph.js';
import { serializeConnectionMap } from '../serialize.js';
import { runQuery } from './query.js';

const METADATA = { generatedAt: '2026-01-01T00:00:00Z' };
const CRATE = 'package:cargo:crates/core#lib:core';

describe('balk2 query: language, package focus, and ranking', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-query-structure-'));
    const graph = new ConnectionGraph();
    graph.addFile('crates/core/src/lib.rs', 'rust');
    graph.addFile('crates/core/src/parse.rs', 'rust');
    graph.addFile('web/src/search.ts', 'typescript');
    graph.addPackage({
      kind: 'package',
      id: CRATE,
      ecosystem: 'cargo',
      name: 'core',
      target: 'lib',
      manifest: 'crates/core/Cargo.toml',
      roots: ['crates/core/src/lib.rs'],
    });
    graph.addRelationship('packageRoot', CRATE, 'crates/core/src/lib.rs', 'high');
    graph.addRelationship(
      'declaresModule',
      'crates/core/src/lib.rs',
      'crates/core/src/parse.rs',
      'high',
    );
    graph.addRelationship('calls', 'web/src/search.ts', 'crates/core/src/lib.rs', 'high');
    fs.writeFileSync(
      path.join(tmpDir, 'connection-map.json'),
      serializeConnectionMap(graph.build(METADATA)),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('focuses on a package by its id', () => {
    const result = runQuery([`--focus=${CRATE}`], tmpDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`${CRATE} --packageRoot--> crates/core/src/lib.rs [high]`);
  });

  it('filters the output to one language', () => {
    const result = runQuery(['--language', 'rust', '--family', 'code'], tmpDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'crates/core/src/lib.rs --declaresModule--> crates/core/src/parse.rs [high]',
    );
    expect(result.stdout.join('\n')).not.toContain('web/src/search.ts');
  });

  it('rejects an unknown language and lists the valid ones', () => {
    const result = runQuery(['--language', 'cobol'], tmpDir);
    expect(result.exitCode).toBe(2);
    expect(result.stderr[0]).toContain('unknown value "cobol"');
    expect(result.stderr[0]).toContain('javascript, typescript, python, rust');
  });

  it('accepts the package node kind in --node-kind', () => {
    const only = runQuery(['--node-kind', 'package', '--family', 'code'], tmpDir);
    expect(only.exitCode).toBe(0);
    expect(only.stdout).toEqual(['no relationships match']);

    const result = runQuery(['--node-kind', 'package,file', '--family', 'code'], tmpDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`${CRATE} --packageRoot--> crates/core/src/lib.rs [high]`);
  });

  it('keeps the code edge when a limit cuts the packaging edge', () => {
    const result = runQuery(['--focus', 'crates/core/src/lib.rs', '--limit', '1'], tmpDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.join('\n')).toContain(
      'web/src/search.ts --calls--> crates/core/src/lib.rs',
    );
    expect(result.stdout.join('\n')).not.toContain('--declaresModule-->');
  });
});
