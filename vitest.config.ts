import * as os from 'node:os';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Many tests build a TypeScript program (and the CLI tests build two), which takes seconds on
    // a busy machine. The 5s default is too tight when test files run side by side.
    testTimeout: 30_000,
    hookTimeout: 180_000,
    // Vitest's worker RPC (onTaskUpdate) gives up after 60 seconds without an answer. A worker that
    // waits on a synchronous child process cannot answer, so tests must await child processes (see
    // src/package.test.ts). Fewer forks than cores also leave the runner headroom on small CI
    // machines. This is a margin, not the fix.
    poolOptions: {
      forks: { maxForks: Math.max(1, Math.floor(os.cpus().length / 2)) },
    },
  },
});
