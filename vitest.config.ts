import * as os from 'node:os';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Many tests build a TypeScript program (and the CLI tests build two), which takes seconds on
    // a busy machine. The 5s default is too tight when test files run side by side.
    testTimeout: 30_000,
    hookTimeout: 180_000,
    // Leave a core free for vitest's own process. When every core is running a long synchronous
    // TypeScript build, the runner cannot answer its workers in time and reports a
    // "Timeout calling onTaskUpdate" error even though the tests passed.
    poolOptions: {
      forks: { maxForks: Math.max(1, os.cpus().length - 1) },
    },
  },
});
