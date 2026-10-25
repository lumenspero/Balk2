import { posix } from 'path';

/** What the resolver can see of the repository. */
export interface CommandEnvironment {
  /** Every repository file, by repository-relative path. */
  readonly files: ReadonlySet<string>;
  /** The `scripts` of the package.json in a directory (`''` for the root), or undefined. */
  readonly npmScripts: (packageDir: string) => Readonly<Record<string, string>> | undefined;
  /** The entry file of the Cargo binary with this name, or undefined. */
  readonly binaryFile: (name: string) => string | undefined;
}

/**
 * The script a command runs.
 *
 * - `script`: the command runs a file that is in the repository.
 * - `unresolved`: the command names a script that is not in the repository.
 */
export type CommandResolution =
  | { readonly kind: 'script'; readonly file: string }
  | { readonly kind: 'unresolved'; readonly subject: string };

const PYTHON = /^(python(\d(\.\d+)?)?|py)$/;
const NODE = new Set(['node', 'tsx', 'ts-node']);
const SCRIPT_EXTENSION = /\.(py|m?js|cjs|ts)$/;
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn']);

/** How many `npm run` hops a command may take. Stops a script that runs itself. */
const MAX_DEPTH = 3;

/**
 * Resolve a literal command to the repository file it runs. A command that is not one of the
 * recognized forms resolves to nothing, so no edge is written for it.
 *
 * Recognized forms: `python`, `python3`, `py`, `node`, `tsx` or `ts-node` with a script; a script
 * path run directly; `npm`, `pnpm` or `yarn run <script>` through the package's `scripts`; and
 * `cargo run --bin <name>` or `-p <crate>`. `-m` and `-c` run a module or a string, so they are not
 * resolved.
 */
export function resolveCommand(
  argv: readonly string[],
  env: CommandEnvironment,
  packageDir: string,
  depth = 0,
): CommandResolution | undefined {
  if (argv.length === 0 || depth > MAX_DEPTH) return undefined;
  const [program = '', ...rest] = argv;
  const name = posix.basename(program).replace(/\.exe$/i, '');

  if (PYTHON.test(name) || NODE.has(name)) {
    for (const arg of rest) {
      if (arg === '-m' || arg === '-c') return undefined;
      if (!arg.startsWith('-')) return scriptOf(arg, env, packageDir);
    }
    return undefined;
  }
  if (SCRIPT_EXTENSION.test(program)) return scriptOf(program, env, packageDir);

  if (PACKAGE_MANAGERS.has(name)) {
    const runAt = rest.findIndex((arg) => arg === 'run' || arg === 'run-script');
    const script = runAt < 0 ? undefined : rest[runAt + 1];
    if (script === undefined) return undefined;
    const command = env.npmScripts(packageDir)?.[script];
    if (command === undefined) return undefined;
    return resolveCommand(splitWords(command), env, packageDir, depth + 1);
  }

  if (name === 'cargo' && rest[0] === 'run') {
    const binary =
      flagValue(rest, '--bin') ?? flagValue(rest, '-p') ?? flagValue(rest, '--package');
    if (binary === undefined) return undefined;
    const file = env.binaryFile(binary);
    return file === undefined ? undefined : { kind: 'script', file };
  }
  return undefined;
}

/**
 * The directory of the nearest package.json at or above a file, `''` for the root, or `''` when
 * no package.json is found.
 */
export function nearestPackageDir(file: string, files: ReadonlySet<string>): string {
  let dir = posix.dirname(file);
  for (;;) {
    const candidate = dir === '.' ? 'package.json' : `${dir}/package.json`;
    if (files.has(candidate)) return dir === '.' ? '' : dir;
    if (dir === '.' || dir === '') return '';
    dir = posix.dirname(dir);
  }
}

/** A script path is relative to the directory of the package the command runs in. */
function scriptOf(
  path: string,
  env: CommandEnvironment,
  base: string,
): CommandResolution | undefined {
  const file = posix.normalize(posix.join(base, path));
  if (env.files.has(file)) return { kind: 'script', file };
  if (SCRIPT_EXTENSION.test(file)) return { kind: 'unresolved', subject: path };
  return undefined;
}

/** A command line split into words, as a shell would before running it. */
export function splitWords(line: string): string[] {
  return line.split(/\s+/).filter((word) => word.length > 0);
}

/** The value of a flag written as `--flag value` or `--flag=value`. */
function flagValue(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  if (at >= 0) return args[at + 1];
  const prefixed = args.find((arg) => arg.startsWith(`${flag}=`));
  return prefixed === undefined ? undefined : prefixed.slice(flag.length + 1);
}
