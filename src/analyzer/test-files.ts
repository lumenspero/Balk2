/**
 * Test code, by path (V3 decision D5). A file is test code when its name or folder follows a test
 * convention of one of the three languages:
 *
 * - JavaScript and TypeScript: `*.test.*` and `*.spec.*` files, and `__tests__/` folders.
 * - Python: `test_*.py`, `*_test.py`, `conftest.py`.
 * - Rust: files under a `tests/` folder (integration tests).
 *
 * Any language: a file under a `tests/` or `test/` folder. Inline `#[cfg(test)]` modules stay in the
 * file that holds them and are not tagged here.
 */
export function isTestFile(path: string): boolean {
  const segments = path.replace(/\\/g, '/').split('/');
  const base = segments[segments.length - 1] ?? '';
  const folders = segments.slice(0, -1);
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(base)) return true;
  if (/^test_.*\.py$/.test(base) || /_test\.py$/.test(base) || base === 'conftest.py') return true;
  return folders.some(
    (folder) => folder === 'tests' || folder === 'test' || folder === '__tests__',
  );
}
