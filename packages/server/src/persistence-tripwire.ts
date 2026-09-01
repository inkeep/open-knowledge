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
