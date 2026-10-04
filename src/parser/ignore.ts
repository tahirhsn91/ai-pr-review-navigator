export function isIgnored(path: string, patterns: readonly string[]): boolean {
  const normalized = path.replace(/\\/gu, "/");
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  let index = 0;
  while (index < pattern.length) {
    if (pattern.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 3;
      continue;
    }
    if (pattern.startsWith("**", index)) {
      source += ".*";
      index += 2;
      continue;
    }
    const character = pattern[index];
    if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else if (character !== undefined) {
      source += escapeRegExp(character);
    }
    index += 1;
  }
  return new RegExp(`${source}$`, "u");
}

function escapeRegExp(character: string): string {
  return /[.+^${}()|[\]\\]/u.test(character) ? `\\${character}` : character;
}
