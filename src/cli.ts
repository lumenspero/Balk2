#!/usr/bin/env node

import { createRequire } from 'node:module';
import { generateConnectionMap } from './cli/generate.js';
import { installGitHook, uninstallGitHook } from './cli/hook-installer.js';
import { checkConnectionMap } from './cli/check.js';

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
      console.log(res.message);
      if (!res.isCurrent) process.exit(1);
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

Options:
  -o, --output <path>   Output directory or base file path (default: connection-map)
  -h, --help            Show help
  -v, --version         Show version
`);
}

main();