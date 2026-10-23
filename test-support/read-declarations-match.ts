export type ReadDeclaration = {
  readonly include: readonly string[];
  readonly exclude?: readonly string[];
};

const GLOB_PATTERNS = new Map<string, RegExp>();

function segmentPattern(segment: string): string {
  let pattern = '';
  for (const character of segment) {
    if (character === '*') pattern += '[^/]*';
    else if (character === '?') pattern += '[^/]';
    else pattern += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return pattern;
}

function globMatches(glob: string, path: string): boolean {
  let pattern = GLOB_PATTERNS.get(glob);
  if (pattern === undefined) {
    const segments = glob.split('/');
    let source = '^';
    for (let index = 0; index < segments.length; index += 1) {
      const last = index === segments.length - 1;
      if (segments[index] === '**') source += last ? '.*' : '(?:[^/]+/)*';
      else source += segmentPattern(segments[index]) + (last ? '' : '/');
    }
    pattern = new RegExp(`${source}$`);
    GLOB_PATTERNS.set(glob, pattern);
  }
  return pattern.test(path);
}

function expandBraces(glob: string): string[] | null {
  const open = glob.indexOf('{');
  if (open === -1) return [glob];
  const close = glob.indexOf('}', open);
  if (close === -1) return null;
  const body = glob.slice(open + 1, close);
  if (body.includes('{')) return null;
  const rest = expandBraces(glob.slice(close + 1));
  if (rest === null) return null;
  return body
    .split(',')
    .flatMap((option) => rest.map((tail) => glob.slice(0, open) + option + tail));
}

function matchesAny(globs: readonly string[], path: string): boolean {
  return globs.some((glob) => {
    const variants = expandBraces(glob);
    if (variants === null) {
      throw new Error(
        `The read declaration glob ${JSON.stringify(glob)} has a nested or unterminated brace alternation.`,
      );
    }
    return variants.some((variant) => globMatches(variant, path));
  });
}

export function withDerivedReads(
  declaration: ReadDeclaration,
  derived: readonly string[],
): ReadDeclaration {
  return { ...declaration, include: [...new Set([...declaration.include, ...derived])] };
}

export function declares(declaration: ReadDeclaration, path: string): boolean {
  return matchesAny(declaration.include, path) && !matchesAny(declaration.exclude ?? [], path);
}
