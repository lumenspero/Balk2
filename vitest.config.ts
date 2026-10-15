import * as os from 'node:os';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Many tests build a TypeScript program (and the CLI tests build two), which takes seconds on
    // a busy machine. The 5s default is too tight when test files run side by side.
    testTimeout: 30_000,
    hookTimeout: 180_000,
    // Each worker runs long synchronous TypeScript builds. vitest answers worker calls such as
    // onTaskUpdate over RPC, and that RPC has a fixed 60s timeout that this vitest version does not
    // expose. With one worker per spare core, the runner is starved and reports "Timeout calling
    // onTaskUpdate" even though every test passed, which fails the run. Half the cores keeps
    // enough headroom for the runner to answer in time.
    poolOptions: {
      forks: { maxForks: Math.max(1, Math.floor(os.cpus().length / 2)) },
    },
  },
});
