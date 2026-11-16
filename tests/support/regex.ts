// Safe RegExp construction from literal strings (contract paths, ids, link
// templates). Every literal is fully escaped, so a metacharacter or backslash
// in a contract path can never change what the pattern matches.
// (RegExp.escape exists in Node 24, but the tests tsconfig targets ES2024 and
// CodeQL recognises this explicit form as complete sanitisation.)

/** Escapes every regex metacharacter, backslash included, in `s`. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * The single place tests/ compiles a RegExp from a built string. Callers pass
 * only escapeRegExp() output joined with fixed regex fragments they own (or
 * caller-chosen placeholder sources, never data), so no input can inject syntax.
 */
function compile(escapedSource: string): RegExp {
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- every caller in this module builds the source from escapeRegExp() output plus fixed fragments
  return new RegExp(escapedSource);
}

/**
 * Builds an anchored RegExp from a template: literal text is escaped, and each
 * placeholder (an exact substring of the template) becomes its regex source.
 * At each position the longest matching placeholder wins.
 */
export function templateRegex(
  template: string,
  placeholders: Readonly<Record<string, string>>,
): RegExp {
  const keys = Object.keys(placeholders)
    .filter((k) => k.length > 0)
    .sort((a, b) => b.length - a.length);
  let src = "";
  let literal = "";
  for (let i = 0; i < template.length;) {
    const key = keys.find((k) => template.startsWith(k, i));
    if (key === undefined) {
      literal += template.charAt(i);
      i += 1;
      continue;
    }
    src += escapeRegExp(literal) + placeholders[key]!;
    literal = "";
    i += key.length;
  }
  return compile(`^${src}${escapeRegExp(literal)}$`);
}

/**
 * Anchored matcher for an OpenAPI path template: each `{param}` segment
 * captures one path segment (`([^/]+)`, in order); everything else is literal.
 */
export function openApiPathRegex(path: string): RegExp {
  const src = path
    .split(/\{\w+\}/)
    .map(escapeRegExp)
    .join("([^/]+)");
  return compile(`^${src}$`);
}

/** Matches a string that ends with the literal `suffix`. */
export function endsWithRegex(suffix: string): RegExp {
  return compile(`${escapeRegExp(suffix)}$`);
}
