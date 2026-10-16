// Removes temporary config bundles that tsup leaves behind when a build is interrupted. tsup writes
// tsup.config.bundled_<id>.mjs next to tsup.config.ts, imports it, and deletes it. A build that is
// killed before the delete keeps the file, and the next build then fails when it tries to clean up.
import { readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LEFTOVER = /^tsup\.config\.bundled_[a-z0-9]+\.(m?js|cjs)$/;

for (const name of readdirSync(root)) {
  if (LEFTOVER.test(name)) rmSync(join(root, name), { force: true });
}
