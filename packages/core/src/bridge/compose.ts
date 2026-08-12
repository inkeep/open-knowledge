
import { prependFrontmatter, stripFrontmatter } from '../extensions/frontmatter.ts';

export type ComposeAdjustment = 'none' | 'body' | 'frontmatter' | 'unresolved';

export interface BridgeComposition {
  readonly md: string;
  readonly frontmatter: string;
  readonly body: string;
  readonly adjusted: ComposeAdjustment;
}

const EMPTY_FM_BLOCK_RE = /^---[ \t]*\r?\n---[ \t]*(\r?\n|$)/;

const LEADING_FENCE_RE = /^---([ \t]*)(?=\r?\n|$)/;

const eolOf = (s: string): string => (s.includes('\r\n') ? '\r\n' : '\n');

const respellLeadingRule = (body: string): string => body.replace(LEADING_FENCE_RE, '***$1');

const stableEmptyBlock = (eol: string): string => `---${eol}${eol}---${eol}`;

function composed(frontmatter: string, body: string): { md: string; frontmatter: string } {
  const md = prependFrontmatter(frontmatter, body);
  return { md, frontmatter: md.slice(0, md.length - body.length) };
}

function isUnambiguous(frontmatter: string, body: string): boolean {
  const { md, frontmatter: effective } = composed(frontmatter, body);
  const round = stripFrontmatter(md);
  return round.frontmatter === effective && round.body === body;
}

function settle(
  requested: string,
  frontmatter: string,
  body: string,
  adjusted: ComposeAdjustment,
): BridgeComposition {
  const { md, frontmatter: effective } = composed(frontmatter, body);
  const resolved: ComposeAdjustment =
    adjusted === 'none' && effective !== requested ? 'frontmatter' : adjusted;
  return { md, frontmatter: effective, body, adjusted: resolved };
}

export function composeWithDerivedBody(frontmatter: string, body: string): BridgeComposition {
  if (isUnambiguous(frontmatter, body)) return settle(frontmatter, frontmatter, body, 'none');

  const respelled = respellLeadingRule(body);
  if (respelled !== body && isUnambiguous(frontmatter, respelled)) {
    return settle(frontmatter, frontmatter, respelled, 'body');
  }

  if (EMPTY_FM_BLOCK_RE.test(frontmatter)) {
    const stable = stableEmptyBlock(eolOf(frontmatter));
    if (isUnambiguous(stable, body)) return settle(frontmatter, stable, body, 'frontmatter');
  }

  return settle(frontmatter, frontmatter, body, 'unresolved');
}

export function composeWithDerivedFrontmatter(
  frontmatter: string,
  body: string,
): BridgeComposition {
  if (isUnambiguous(frontmatter, body)) return settle(frontmatter, frontmatter, body, 'none');

  const stable = stableEmptyBlock(eolOf(frontmatter || body));
  if (frontmatter === '' || EMPTY_FM_BLOCK_RE.test(frontmatter)) {
    if (isUnambiguous(stable, body)) return settle(frontmatter, stable, body, 'frontmatter');
  }

  return settle(frontmatter, frontmatter, body, 'unresolved');
}

export function composesAmbiguously(frontmatter: string, body: string): boolean {
  return !isUnambiguous(frontmatter, body);
}
