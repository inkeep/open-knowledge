/**
 * Structural-duplication classifier for the persistence tripwire.
 *
 * Returns `block` only when the candidate body is an integer concatenation
 * (k ≥ 2) of the bridge-normalized base body, separated by inter-copy
 * whitespace only. Frontmatter is stripped from both inputs before
 * comparison, so frontmatter-only changes never block. Size and
 * child-count ratios are NOT inputs — those remain warn-only diagnostics
 * elsewhere.
 *
 * Pure module: no disk I/O, no imports from `persistence.ts`. Reuses
 * `normalizeBridge` (canonical bridge-invariant normalization) and
 * `stripFrontmatter` from the shared markdown pipeline.
 */
import { normalizeBridge, stripFrontmatter } from '@inkeep/open-knowledge-core';

type DuplicationReason =
  | 'empty-base'
  | 'identical'
  | 'too-short'
  | 'not-integer-multiple'
  | 'single-copy'
  | 'structural-duplication';

type DuplicationClassification =
  | { kind: 'allow'; reason: Exclude<DuplicationReason, 'structural-duplication'> }
  | { kind: 'block'; reason: 'structural-duplication'; copies: number };

function normalizeBody(input: string): string {
  const { body } = stripFrontmatter(input);
  return normalizeBridge(body).trim();
}

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r';
}

/**
 * Classify whether `candidate` is a structural duplication of `base`.
 *
 * Block iff, after stripping frontmatter, bridge-normalizing, and
 * trimming both sides, the candidate body equals an integer
 * concatenation of the base body (k ≥ 2) with only inter-copy whitespace
 * between repetitions.
 */
export function classifyDuplication(candidate: string, base: string): DuplicationClassification {
  const baseBody = normalizeBody(base);
  if (baseBody.length === 0) {
    return { kind: 'allow', reason: 'empty-base' };
  }

  const candBody = normalizeBody(candidate);
  if (candBody === baseBody) {
    return { kind: 'allow', reason: 'identical' };
  }
  if (candBody.length < baseBody.length * 2) {
    return { kind: 'allow', reason: 'too-short' };
  }

  let pos = 0;
  let copies = 0;
  while (pos < candBody.length) {
    if (candBody.slice(pos, pos + baseBody.length) !== baseBody) {
      return { kind: 'allow', reason: 'not-integer-multiple' };
    }
    pos += baseBody.length;
    copies++;
    while (pos < candBody.length && isWhitespace(candBody[pos] ?? '')) {
      pos++;
    }
  }

  if (copies >= 2) {
    return { kind: 'block', reason: 'structural-duplication', copies };
  }
  return { kind: 'allow', reason: 'single-copy' };
}
