import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const packageName = '@lumenspero/balk2';
const npmCli = process.env.npm_execpath;

let tempDir = '';
let tarballPath = '';

function run(command: string, args: readonly string[], cwd: string): string {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
      const output = [String(error.stdout).trim(), String(error.stderr).trim()]
        .filter(Boolean)
        .join('\n');
      if (output) error.message = `${error.message}\n${output}`;
    }
    throw error;
  }
}

function runNpm(args: readonly string[], cwd: string): string {
  if (!npmCli) throw new Error('npm_execpath is required to run packed-package tests');
  return run(process.execPath, [npmCli, ...args], cwd);
}

function installConsumer(name: string): string {
  const consumerDir = path.join(tempDir, name);
  fs.mkdirSync(consumerDir, { recursive: true });
  fs.writeFileSync(
    path.join(consumerDir, 'package.json'),
    JSON.stringify({ name, private: true, version: '0.0.0' }, null, 2),
    'utf8',
  );
  runNpm(
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarballPath],
    consumerDir,
  );
  return consumerDir;
}

// These tests pack and install the real tarball, so they are gated on BALK2_PACKAGE_TEST.
// Run them through `npm run test:package` (part of `npm run verify`), which builds first and
// sets the variable. Plain `npm test` skips this block on purpose.
const describePackage = process.env.BALK2_PACKAGE_TEST === 'true' ? describe : describe.skip;

describePackage('packed package contract', () => {
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-package-test-'));
    runNpm(['run', 'build'], projectRoot);

    const packResult = JSON.parse(runNpm(['pack', '--json'], projectRoot)) as Array<{
      filename: string;
      files: Array<{ path: string }>;
    }>;
    const packed = packResult[0];
    if (!packed) throw new Error('npm pack did not return a package archive');

    tarballPath = path.join(projectRoot, packed.filename);
    expect(fs.existsSync(tarballPath)).toBe(true);
    expect(packed.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(['dist/index.js', 'dist/index.cjs', 'dist/index.d.ts', 'dist/cli.js']),
    );
  });

  afterAll(() => {
    if (tarballPath && fs.existsSync(tarballPath)) fs.rmSync(tarballPath);
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('loads the documented root API from an ESM consumer', () => {
    const consumerDir = installConsumer('esm-consumer');
    const output = run(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import { ConnectionGraph, detectArtifactFormat } from '${packageName}';\n` +
          'const graph = new ConnectionGraph();\n' +
          "console.log(graph.nodeCount, detectArtifactFormat('data/output.json'));",
      ],
      consumerDir,
    );

    expect(output.trim()).toBe('0 json');
  });

  it('loads the documented root API from a CommonJS consumer', () => {
    const consumerDir = installConsumer('cjs-consumer');
    const output = run(
      process.execPath,
      [
        '--eval',
        `const { ConnectionGraph, detectArtifactFormat } = require('${packageName}');\n` +
          'const graph = new ConnectionGraph();\n' +
          "console.log(graph.nodeCount, detectArtifactFormat('data/output.json'));",
      ],
      consumerDir,
    );

    expect(output.trim()).toBe('0 json');
  });

  it('resolves root declarations for a Node16 TypeScript consumer', () => {
    const consumerDir = installConsumer('typescript-consumer');
    fs.writeFileSync(
      path.join(consumerDir, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'Node16',
            moduleResolution: 'Node16',
            strict: true,
            noEmit: true,
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    fs.writeFileSync(
      path.join(consumerDir, 'index.ts'),
      `import { ConnectionGraph, type ConnectionMap } from '${packageName}';

const graph = new ConnectionGraph();
const map: ConnectionMap = graph.build({ generatedAt: '2026-10-02T00:00:00.000Z' });
console.log(map.version);
`,
      'utf8',
    );

    const tsc = path.join(consumerDir, 'node_modules', 'typescript', 'bin', 'tsc');
    run(process.execPath, [tsc, '--project', 'tsconfig.json'], consumerDir);
  });

  it('ships the same schema as the source in the installed package', () => {
    const consumerDir = installConsumer('schema-consumer');
    const shipped = path.join(
      consumerDir,
      'node_modules',
      '@lumenspero',
      'balk2',
      'dist',
      'balk2.schema.json',
    );

    expect(fs.readFileSync(shipped, 'utf8')).toBe(
      fs.readFileSync(path.join(projectRoot, 'schemas', 'balk2.schema.json'), 'utf8'),
    );
  });

  it('runs the installed CLI and reports its package version', () => {
    const consumerDir = installConsumer('cli-consumer');
    const cliPath = path.join(
      consumerDir,
      'node_modules',
      '@lumenspero',
      'balk2',
      'dist',
      'cli.js',
    );
    const packageJson = JSON.parse(
      fs.readFileSync(
        path.join(consumerDir, 'node_modules', '@lumenspero', 'balk2', 'package.json'),
        'utf8',
      ),
    ) as { version: string; exports: Record<string, unknown> };

    expect(packageJson.exports).toHaveProperty('.');
    expect(run(process.execPath, [cliPath, '--version'], consumerDir).trim()).toBe(
      `balk2 v${packageJson.version}`,
    );
    expect(run(process.execPath, [cliPath, '--help'], consumerDir)).toContain('Usage:');
  });
  it('loads the language analyzers from an ESM consumer', () => {
    const consumerDir = installConsumer('analyzers-esm-consumer');
    const output = run(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import { PythonAnalyzer, RustAnalyzer } from '${packageName}';\n` +
          "console.log(new PythonAnalyzer().name, new RustAnalyzer().name, new RustAnalyzer().canAnalyze('src/lib.rs'));",
      ],
      consumerDir,
    );

    expect(output.trim()).toBe('PythonAnalyzer RustAnalyzer true');
  });

  it('loads the language analyzers from a CommonJS consumer', () => {
    const consumerDir = installConsumer('analyzers-cjs-consumer');
    const output = run(
      process.execPath,
      [
        '--eval',
        `const { PythonAnalyzer, RustAnalyzer } = require('${packageName}');\n` +
          "console.log(new PythonAnalyzer().name, new RustAnalyzer().name, new PythonAnalyzer().canAnalyze('a.py'));",
      ],
      consumerDir,
    );

    expect(output.trim()).toBe('PythonAnalyzer RustAnalyzer true');
  });

  it('exposes the v3 union values and package types to a TypeScript consumer', () => {
    const consumerDir = installConsumer('v3-types-consumer');
    fs.writeFileSync(
      path.join(consumerDir, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'Node16',
            moduleResolution: 'Node16',
            strict: true,
            noEmit: true,
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    fs.writeFileSync(
      path.join(consumerDir, 'index.ts'),
      `import type { Evidence, NodeKind, PackageEcosystem, PackageNode, SymbolType } from '${packageName}';
import { PythonAnalyzer, RustAnalyzer } from '${packageName}';

const kind: NodeKind = 'package';
const ecosystem: PackageEcosystem = 'cargo';
const symbol: SymbolType[] = ['struct', 'enum', 'trait', 'module', 'macro'];
const evidence: Evidence = 'manifest';
const packageNode: PackageNode | undefined = undefined;
const analyzers = [new PythonAnalyzer(), new RustAnalyzer()];

console.log(kind, ecosystem, symbol.length, evidence, packageNode, analyzers.length);
`,
      'utf8',
    );

    const tsc = path.join(consumerDir, 'node_modules', 'typescript', 'bin', 'tsc');
    run(process.execPath, [tsc, '--project', 'tsconfig.json'], consumerDir);
  });

  it('loads the TOML parser the package depends on from the installed tarball', () => {
    const consumerDir = installConsumer('toml-consumer');
    const output = run(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "import { parse } from 'smol-toml';\n" +
          'console.log(parse(\'[package]\\nname = "core"\').package.name);',
      ],
      consumerDir,
    );

    expect(output.trim()).toBe('core');
  });

  it('generates maps for Python, Rust and mixed fixtures with the installed CLI', () => {
    const consumerDir = installConsumer('cli-fixtures-consumer');
    const cliPath = path.join(
      consumerDir,
      'node_modules',
      '@lumenspero',
      'balk2',
      'dist',
      'cli.js',
    );
    const fixtures = ['python-baseline', 'cargo-single', 'mixed-project'];

    for (const name of fixtures) {
      const work = path.join(tempDir, `work-${name}`);
      fs.cpSync(path.join(projectRoot, 'test', 'fixtures', name), work, { recursive: true });

      run(process.execPath, [cliPath, 'generate'], work);
      const map = JSON.parse(fs.readFileSync(path.join(work, 'connection-map.json'), 'utf8')) as {
        files: Record<string, { language?: string }>;
      };
      expect(Object.keys(map.files).length, `${name} has files`).toBeGreaterThan(0);
      run(process.execPath, [cliPath, 'check'], work);

      if (name === 'mixed-project') {
        const languages = new Set(Object.values(map.files).map((file) => file.language));
        // Manifests are file nodes tagged by ecosystem (Phase 1.4), next to the three source languages.
        expect([...languages].sort()).toEqual([
          'cargo-manifest',
          'npm-manifest',
          'python',
          'rust',
          'typescript',
        ]);
      }
    }
  });
});
