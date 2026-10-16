// Copies the .balk2.json schema into dist/ so installed packages can reference it.
// Runs after tsup in the build script; tsup's clean step has already emptied dist/ by then.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'schemas', 'balk2.schema.json');
const target = resolve(root, 'dist', 'balk2.schema.json');

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
