/**
 * Converts a workspace member glob into a regular expression over repository paths. `*` and `?`
 * stay within one path segment, and `**` spans any number of segments. Character classes are not
 * supported, and they are matched literally.
 */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  let index = 0;
  while (index < glob.length) {
    if (glob.startsWith('**/', index)) {
      source += '(?:.*/)?';
      index += 3;
    } else if (glob.startsWith('**', index)) {
      source += '.*';
      index += 2;
    } else if (glob[index] === '*') {
      source += '[^/]*';
      index += 1;
    } else if (glob[index] === '?') {
      source += '[^/]';
      index += 1;
    } else {
      source += escapeRegExp(glob[index] ?? '');
      index += 1;
    }
  }
  return new RegExp(`^${source}$`);
}

function escapeRegExp(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
