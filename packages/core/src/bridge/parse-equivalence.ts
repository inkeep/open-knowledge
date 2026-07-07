import { stripFrontmatter } from '../extensions/frontmatter.ts';
import type { BridgeToleranceClass } from './normalize.ts';

export const PARSE_EQUIVALENCE_TOLERANCE = 'parse-equivalence' as const;

export type BridgeToleranceSignal = BridgeToleranceClass | typeof PARSE_EQUIVALENCE_TOLERANCE;

function stripDocBoundary(body: string): string {
  return body.replace(/^\n+/, '').replace(/\n+$/, '');
}

function stripTrailingLineWhitespace(body: string): string {
  return body.replace(/[ \t]+$/gm, '');
}

/** Leading ordered-list marker digits (after optional indent), canonicalized
 *  before skeletonizing so remark-stringify's lazy-list renumbering
 *  (`1.`/`1.` → `1.`/`2.`) doesn't read as a content substitution in the
 *  preservation probe. Only the digits collapse; delimiter + content stay. */
const ORDERED_MARKER_DIGITS_RE = /^([ \t]*)\d+([.)])(?=[ \t])/;

function contentSkeleton(body: string): string {
  return body
    .split('\n')
    .map((line) =>
      line.replace(ORDERED_MARKER_DIGITS_RE, (_m, indent, delim) => `${indent}1${delim}`),
    )
    .join('')
    .replace(/\s+/g, '');
}

/** Breadcrumb gate for canonicalizeBody throws: warn once per DISTINCT
 *  error message (bounded set) so a systematic parser regression arriving
 *  after an unrelated exotic-doc throw still surfaces its own signature,
 *  without any per-drain flood. */
const warnedCanonicalizeErrors = new Set<string>();
const MAX_WARNED_CANONICALIZE_ERRORS = 8;

/** True when `needle` appears in `haystack` as a subsequence (two-pointer,
 *  O(n+m)). Insertions in `haystack` are free; any dropped or substituted
 *  `needle` byte fails. */
function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (needle[i] === haystack[j]) i++;
  }
  return i === needle.length;
}

export function isParseEquivalentBridge(
  left: string,
  right: string,
  canonicalizeBody: (body: string) => string,
): boolean {
  const leftSplit = stripFrontmatter(left);
  const rightSplit = stripFrontmatter(right);
  if (leftSplit.frontmatter !== rightSplit.frontmatter) return false;
  if (leftSplit.body === rightSplit.body) return true;
  let canonicalLeftBody: string;
  try {
    canonicalLeftBody = canonicalizeBody(leftSplit.body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      warnedCanonicalizeErrors.size < MAX_WARNED_CANONICALIZE_ERRORS &&
      !warnedCanonicalizeErrors.has(message)
    ) {
      warnedCanonicalizeErrors.add(message);
      console.warn(
        '[parse-equivalence] canonicalizeBody threw; treating as not equivalent:',
        message,
      );
    }
    return false;
  }
  if (
    stripDocBoundary(stripTrailingLineWhitespace(canonicalLeftBody)) !==
    stripDocBoundary(stripTrailingLineWhitespace(rightSplit.body))
  ) {
    return false;
  }
  return isSubsequence(contentSkeleton(leftSplit.body), contentSkeleton(canonicalLeftBody));
}
