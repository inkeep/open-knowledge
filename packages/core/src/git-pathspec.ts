export type Pathspec = string & { readonly __brand: 'Pathspec' };

type Assert<T extends true> = T;

type _RawStringIsNotAPathspec = Assert<string extends Pathspec ? false : true>;

const LITERAL_MAGIC = ':(literal)';

export function toPathspec(path: string & { readonly __brand?: undefined }): Pathspec {
  if (path === '') {
    throw new Error(
      'toPathspec: empty path. ":(literal)" is an empty pattern that matches every tracked path; pass "." if you meant the repo root.',
    );
  }
  return `${LITERAL_MAGIC}${path}` as Pathspec;
}

export function pathspecArgs(
  paths: readonly (string & { readonly __brand?: undefined })[],
): [string, ...Pathspec[]] {
  if (paths.length === 0) {
    throw new Error(
      'pathspecArgs: empty path list. A bare "--" removes the pathspec restriction rather than selecting nothing.',
    );
  }
  return ['--', ...paths.map((p) => toPathspec(p))];
}

export function stripPathspecMagic(text: string): string {
  return text.replaceAll(LITERAL_MAGIC, '');
}
