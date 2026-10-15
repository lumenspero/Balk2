/**
 * A repository-relative glob as a regular expression. `*` matches within one path segment, `**`
 * across segments (`src/**` and `src/**\/*.ts` both work), and `?` one character. Everything else
 * matches itself.
 */
export function compileGlob(pattern: string): RegExp {
  let source = '';
  let index = 0;
  while (index < pattern.length) {
    const char = pattern.charAt(index);
    if (char === '*' && pattern.charAt(index + 1) === '*') {
      if (pattern.charAt(index + 2) === '/') {
        source += '(?:.*/)?';
        index += 3;
      } else {
        source += '.*';
        index += 2;
      }
    } else if (char === '*') {
      source += '[^/]*';
      index += 1;
    } else if (char === '?') {
      source += '[^/]';
      index += 1;
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      index += 1;
    }
  }
  return new RegExp(`^${source}$`);
}
