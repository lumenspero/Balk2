import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildConnectionGraph } from '../../cli/build-graph.js';
import type { ConnectionGraph } from '../../graph.js';
import { resolveCommand, type CommandEnvironment } from './commands.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function repoWith(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-process-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return root;
}

function executesOf(graph: ConnectionGraph): { from: string; to: string; confidence: string }[] {
  return graph
    .getRelationships()
    .filter((r) => r.type === 'executes')
    .map((r) => ({ from: r.from, to: r.to, confidence: r.confidence }));
}

const SCRIPT = 'export const SCRIPT = 1;\n';

describe('JS/TS process execution (Phase 14.5)', () => {
  it('a literal spawn of a repository script is an executes edge from the enclosing function', () => {
    const root = repoWith({
      'app.js': `import { spawn } from 'child_process';\nexport function run() {\n  spawn('node', ['scripts/build.js']);\n}\n`,
      'scripts/build.js': SCRIPT,
    });
    expect(executesOf(buildConnectionGraph(root))).toEqual([
      { from: 'app.js:run', to: 'scripts/build.js', confidence: 'high' },
    ]);
  });

  it('npm run resolves through the package.json script to the script it runs', () => {
    const root = repoWith({
      'package.json': JSON.stringify({ name: 'web', scripts: { gen: 'node scripts/gen.js' } }),
      'app.js': `const cp = require('node:child_process');\nexport function go() {\n  cp.execSync('npm run gen');\n}\n`,
      'scripts/gen.js': SCRIPT,
    });
    const edges = executesOf(buildConnectionGraph(root));
    expect(edges).toContainEqual({ from: 'app.js:go', to: 'scripts/gen.js', confidence: 'high' });
    // The package.json script itself is a manifest-evidence edge to the same script.
    expect(edges).toContainEqual({
      from: 'package.json',
      to: 'scripts/gen.js',
      confidence: 'high',
    });
  });

  it('a command that is not a literal is an observation, not a file edge', () => {
    const root = repoWith({
      'app.js': `import { exec } from 'child_process';\nexport function run(cmd) {\n  exec(cmd);\n}\n`,
    });
    const edges = executesOf(buildConnectionGraph(root));
    expect(edges).toHaveLength(1);
    expect(edges[0]?.to.endsWith('.js')).toBe(false);
  });

  it('a script that is not in the repository is an unresolved path', () => {
    const root = repoWith({
      'app.js': `import { spawn } from 'child_process';\nexport function run() {\n  spawn('node', ['scripts/missing.js']);\n}\n`,
    });
    const edges = executesOf(buildConnectionGraph(root));
    expect(edges).toHaveLength(1);
    expect(edges[0]?.to.endsWith('.js')).toBe(false);
  });

  it('a module that is not child_process is not a process call', () => {
    const root = repoWith({
      'app.js': `import { spawn } from './local.js';\nexport function run() {\n  spawn('node', ['scripts/build.js']);\n}\n`,
      'local.js': 'export function spawn() {}\n',
      'scripts/build.js': SCRIPT,
    });
    expect(executesOf(buildConnectionGraph(root))).toHaveLength(0);
  });
});

describe('Python process execution (Phase 14.5)', () => {
  it('subprocess.run with a literal list runs the script it names', () => {
    const root = repoWith({
      'pkg/app.py': `import subprocess\n\ndef go():\n    subprocess.run(["python3", "tools/gen.py", "--fast"])\n`,
      'tools/gen.py': 'print(1)\n',
    });
    expect(executesOf(buildConnectionGraph(root))).toEqual([
      { from: 'pkg/app.py:go', to: 'tools/gen.py', confidence: 'high' },
    ]);
  });

  it('os.system with a command line at module level is owned by the file', () => {
    const root = repoWith({
      'run.py': `import os as operating\n\noperating.system("python3 tools/gen.py")\n`,
      'tools/gen.py': 'print(1)\n',
    });
    expect(executesOf(buildConnectionGraph(root))).toEqual([
      { from: 'run.py', to: 'tools/gen.py', confidence: 'high' },
    ]);
  });

  it('a non-literal command is an observation, and an unimported name is not a process call', () => {
    const root = repoWith({
      'app.py': `import subprocess\nimport other\n\ndef go(cmd):\n    subprocess.run(cmd)\n    other.run(["python3", "tools/gen.py"])\n`,
      'other.py': 'def run(args):\n    pass\n',
      'tools/gen.py': 'print(1)\n',
    });
    const edges = executesOf(buildConnectionGraph(root));
    expect(edges).toHaveLength(1);
    expect(edges[0]?.to).not.toBe('tools/gen.py');
  });
});

describe('Rust process execution (Phase 14.5)', () => {
  it('Command::new with literal arguments runs the script it names', () => {
    const root = repoWith({
      'src/lib.rs': `use std::process::Command;\n\npub fn build() {\n    Command::new("python3").arg("tools/gen.py").args(["--fast"]).status().ok();\n}\n`,
      'tools/gen.py': 'print(1)\n',
    });
    expect(executesOf(buildConnectionGraph(root))).toEqual([
      { from: 'src/lib.rs:build', to: 'tools/gen.py', confidence: 'high' },
    ]);
  });

  it('a Command whose argument is a variable is an observation', () => {
    const root = repoWith({
      'src/lib.rs': `use std::process::Command;\n\npub fn build(name: &str) {\n    Command::new("python3").arg(name).status().ok();\n}\n`,
    });
    const edges = executesOf(buildConnectionGraph(root));
    expect(edges).toHaveLength(1);
    expect(edges[0]?.to.endsWith('.py')).toBe(false);
  });
});

describe('resolveCommand', () => {
  const env: CommandEnvironment = {
    files: new Set(['scripts/a.py', 'pkg/tools/b.js', 'pkg/package.json']),
    npmScripts: (dir) => (dir === 'pkg' ? { run: 'node tools/b.js' } : undefined),
    binaryFile: (name) => (name === 'ingest' ? 'crates/ingest/src/main.rs' : undefined),
  };

  it('a script path is relative to the package that runs it', () => {
    expect(resolveCommand(['node', 'tools/b.js'], env, 'pkg')).toEqual({
      kind: 'script',
      file: 'pkg/tools/b.js',
    });
  });

  it('npm run follows the scripts of the nearest package', () => {
    expect(resolveCommand(['npm', 'run', 'run'], env, 'pkg')).toEqual({
      kind: 'script',
      file: 'pkg/tools/b.js',
    });
  });

  it('cargo run --bin names a binary by its entry file', () => {
    expect(resolveCommand(['cargo', 'run', '--bin', 'ingest'], env, '')).toEqual({
      kind: 'script',
      file: 'crates/ingest/src/main.rs',
    });
  });

  it('a module or inline-code invocation is not resolved', () => {
    expect(resolveCommand(['python3', '-m', 'pytest'], env, '')).toBeUndefined();
    expect(resolveCommand(['python3', '-c', 'print(1)'], env, '')).toBeUndefined();
  });
});

function manifestEdgesOf(
  graph: ConnectionGraph,
): { from: string; to: string; evidence: string | undefined }[] {
  return graph
    .getRelationships()
    .filter((r) => r.type === 'executes')
    .map((r) => ({ from: r.from, to: r.to, evidence: r.evidence }));
}

describe('manifest process execution (Phase 14.5)', () => {
  it('a package.json script that runs a repository script is an executes edge with manifest evidence', () => {
    const root = repoWith({
      'package.json': JSON.stringify({ name: 'web', scripts: { build: 'node scripts/build.js' } }),
      'scripts/build.js': SCRIPT,
    });
    expect(manifestEdgesOf(buildConnectionGraph(root))).toEqual([
      { from: 'package.json', to: 'scripts/build.js', evidence: 'manifest' },
    ]);
  });

  it('a Makefile recipe runs its script, and a recipe with a variable program is an observation', () => {
    const root = repoWith({
      Makefile: 'gen:\n\tpython3 tools/gen.py --fast\n\nbuild:\n\t$(PY) scripts/x.py\n',
      'tools/gen.py': 'print(1)\n',
    });
    const edges = manifestEdgesOf(buildConnectionGraph(root));
    expect(edges).toHaveLength(2);
    expect(edges).toContainEqual({ from: 'Makefile', to: 'tools/gen.py', evidence: 'manifest' });
    expect(edges.find((e) => e.to !== 'tools/gen.py')?.to.endsWith('.py')).toBe(false);
  });

  it('a [project.scripts] entry runs its module under src/, and a missing module is unresolved', () => {
    const root = repoWith({
      'pyproject.toml':
        '[project]\nname = "tool"\n\n[project.scripts]\ntool = "pkg.cli:main"\ngone = "nothere:go"\n',
      'src/pkg/cli.py': 'def main():\n    pass\n',
    });
    const edges = manifestEdgesOf(buildConnectionGraph(root));
    expect(edges).toContainEqual({
      from: 'pyproject.toml',
      to: 'src/pkg/cli.py',
      evidence: 'manifest',
    });
    expect(edges).toHaveLength(2);
    expect(edges.find((e) => e.to !== 'src/pkg/cli.py')?.to.endsWith('.py')).toBe(false);
  });
});
