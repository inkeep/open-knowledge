import { pathspecArgs, toPathspec } from './git-pathspec.ts';
import type { Bcp47Tag } from './i18n/bcp47.ts';

// @ts-expect-error -- a Pathspec is already converted; re-converting yields ':(literal):(literal)x', which matches nothing.
const _doubleConverted = toPathspec(toPathspec('x'));
void _doubleConverted;

// @ts-expect-error -- pathspecArgs returns branded operands, so re-feeding its result would convert the separator too.
const _reConvertedArgs = pathspecArgs(pathspecArgs(['a']));
void _reConvertedArgs;

// @ts-expect-error -- a sibling brand is not a raw path; pins the cross-brand rejection so a future brand declared with a different key cannot be accepted as an unconverted path.
const _siblingBrand = toPathspec('en-US' as Bcp47Tag);
void _siblingBrand;
