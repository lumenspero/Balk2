/** Normalize a path to forward slashes and remove leading ./ */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}
