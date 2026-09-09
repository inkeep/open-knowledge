import { extractComments, jsxModeForPath } from './extract.mjs';
import { extractHashComments, hashDialectFor } from './extract-hash.mjs';

export class UnknownFamilyError extends Error {
  constructor(relPath, extractor) {
    super(
      extractor === undefined
        ? `no family in the scope config claims ${relPath}, so no grammar can read it. Reading it ` +
            'under a guessed grammar is worse than refusing: the slash lexer over shell source ' +
            'finds no hash comment and invents one out of a URL.'
        : `${relPath} resolves to extractor ${JSON.stringify(extractor)}, which this predicate ` +
            'does not implement. A family reaches the gate only once its extractor and that ' +
            "extractor's own comment-position reference are both in the tree.",
    );
    this.name = 'UnknownFamilyError';
    this.relPath = relPath;
    this.extractor = extractor;
  }
}

const ESM_FILE_CLASS_RE = /\.(?:mjs|cjs|js)$/;

const GRAMMAR_FAMILIES = {
  'c-family': {
    fileClassFor: (relPath) => (ESM_FILE_CLASS_RE.test(relPath) ? 'esm-script' : 'typescript'),
    extract: (source, { relPath }) => extractComments(source, { jsx: jsxModeForPath(relPath) }),
  },
  'hash-family': {
    fileClassFor: (relPath, extensions) => hashDialectFor(relPath, { extensions }),
    extract: (source, { relPath, extensions }) =>
      extractHashComments(source, { dialect: hashDialectFor(relPath, { extensions }) }),
  },
};

export const GRAMMAR_EXTRACTORS = Object.keys(GRAMMAR_FAMILIES);

export function grammarFor(relPath, family) {
  if (family === null || family === undefined) throw new UnknownFamilyError(relPath);
  const grammar = GRAMMAR_FAMILIES[family.extractor];
  if (grammar === undefined) throw new UnknownFamilyError(relPath, family.extractor);
  return {
    extractor: family.extractor,
    fileClass: grammar.fileClassFor(relPath, family.extensions),
    extract: (source) => grammar.extract(source, { relPath, extensions: family.extensions }),
  };
}
