#!/usr/bin/env node

import { createRequire } from 'node:module';
import { generateConnectionMap } from './cli/generate.js';
import { installGitHook, uninstallGitHook } from './cli/hook-installer.js';
import { checkConnectionMap } from './cli/check.js';
import { failureLines, parseFailOn, type DiagnosticKind } from './cli/diagnostics.js';
import { QUERY_USAGE, runQuery } from './cli/query.js';

const packageMetadata = createRequire(import.meta.url)('../package.json') as { version: string };

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0] && !args[0].startsWith('-') ? args[0] : 'generate';

  let outputOption: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o' || args[i] === '--output') {
      outputOption = args[i + 1];
      break;
    }
  }

  let failOnText: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--fail-on') failOnText = args[i + 1] ?? '';
    else if (args[i]?.startsWith('--fail-on=')) failOnText = args[i]!.slice('--fail-on='.length);
  }
  let failOn: DiagnosticKind[] | undefined;
  if (failOnText !== undefined) {
    try {
      failOn = parseFailOn(failOnText);
    } catch (error) {
      console.error(`balk2: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(2);
    }
  }

  if (command === 'query' && (args.includes('-h') || args.includes('--help'))) {
    console.log(`Usage:\n  ${QUERY_USAGE}`);
    process.exit(0);
  }

  if (args.includes('-h') || args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  if (args.includes('-v') || args.includes('--version')) {
    console.log(`balk2 v${packageMetadata.version}`);
    process.exit(0);
  }

  switch (command) {
    case 'generate': {
      try {
        const res = generateConnectionMap({ output: outputOption });
        for (const line of res.warnings) console.warn(line);
        if (failOn) {
          const failures = failureLines(res.diagnostics, failOn);
          for (const line of failures) console.error(line);
          if (failures.length > 0) process.exit(1);
        }
        console.log(`Generated repository connection map:`);
        console.log(`  JSON: ${res.jsonPath}`);
        console.log(`  Markdown: ${res.mdPath}`);
      } catch (err) {
        console.error(
          `Error generating connection map: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
      break;
    }

    case 'install': {
      const res = installGitHook();
      console.log(res.message);
      if (!res.success) process.exit(1);
      break;
    }

    case 'uninstall': {
      const res = uninstallGitHook();
      console.log(res.message);
      if (!res.success) process.exit(1);
      break;
    }

    case 'check': {
      const res = checkConnectionMap({ output: outputOption });
      for (const line of res.warnings) console.warn(line);
      if (failOn) {
        const failures = failureLines(res.diagnostics, failOn);
        for (const line of failures) console.error(line);
        if (failures.length > 0) process.exit(1);
      }
      console.log(res.message);
      if (!res.isCurrent) process.exit(1);
      break;
    }

    case 'query': {
      const res = runQuery(args.slice(1));
      for (const line of res.stderr) console.error(line);
      for (const line of res.stdout) console.log(line);
      if (res.exitCode !== 0) process.exit(res.exitCode);
      break;
    }

    default: {
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
    }
  }
}

function printHelp(): void {
  console.log(`
balk2 — Repository Connection Map Generator for AI Agents

Usage:
  balk2 [command] [options]

Commands:
  generate              Generate connection-map.json and connection-map.md (default)
  install               Install Git pre-commit hook for automatic map regeneration
  uninstall             Remove installed Git pre-commit hook
  check                 Check whether connection map is current with repository state
  query                 Show relationships from connection-map.json, optionally around a file or node

Options:
  -o, --output <path>   Output directory, or a .json or .md file path (default: connection-map)
  --fail-on <kinds>     With generate or check, exit 1 when a selected diagnostic is found. Comma-separated
                        kinds: syntax, config, or an unresolved reason such as ambiguous-global
  -h, --help            Show help
  -v, --version         Show version

Run "balk2 query --help" for query options.
`);
}

main();
