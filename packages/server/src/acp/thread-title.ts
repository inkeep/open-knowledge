/**
 * Thread-title derivation for the ACP dock.
 *
 * Tab labels get ~160px, so the first words of a prompt ARE the title in
 * practice — and real prompts overwhelmingly open with the same filler
 * ("please", "can you", "hey, could you take a look at…"), which made every
 * tab read identically. `deriveThreadTitle` strips that shared lead-in so the
 * distinguishing words surface first, and falls back to the raw line whenever
 * stripping would leave a stub too short to stand as a title.
 *
 * Heuristics are English-only by design: a non-matching prompt passes through
 * unchanged, so other languages simply keep today's behavior. The manual
 * escape hatch is the `rename` op (tab double-click), which routes through
 * `clampThreadTitle` without any stripping.
 */

export const TITLE_MAX_CHARS = 48;

/**
 * Leading filler a prompt's first line may open with, longest-first so
 * multi-word frames win over their single-word prefixes ("can you" before
 * "can" — bare aux verbs are deliberately absent so questions like "Will this
 * break X?" keep their meaning).
 */
const FILLER_PREFIXES = [
  'do you mind',
  'i would like you to',
  "i'd like you to",
  'i want you to',
  'i need you to',
  'i would like to',
  "i'd like to",
  'i want to',
  'i need to',
  'we need to',
  'we want to',
  'we should',
  'go ahead and',
  'take a look at',
  'have a look at',
  'look into',
  'look at',
  'help me with',
  'help me to',
  'help me',
  'can you',
  'could you',
  'would you',
  'will you',
  'can we',
  'could we',
  'should we',
  "let's",
  'lets',
  'try to',
  'please',
  'kindly',
  'hello',
  'alright',
  'actually',
  'anyway',
  'also',
  'okay',
  'hey',
  'hi',
  'yo',
  'ok',
  'so',
  'pls',
  'plz',
  'just',
  'maybe',
];

const FILLER_RE = new RegExp(
  `^(?:${FILLER_PREFIXES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b(?:[\\s,:;!.\\-–—]+|$)`,
  'i',
);

/** Markdown lead-in on a prompt's first line: headings, quotes, list markers. */
const MARKDOWN_LEAD_RE = /^(?:[#>]+\s*|[-*]\s+|\d+[.)]\s+)+/;

/** Guard against a pathological prefix chain; real prompts stack 2-3 deep. */
const MAX_STRIP_PASSES = 6;

function firstLine(raw: string): string {
  return (raw.trim().split('\n')[0] ?? '').trim();
}

/**
 * Clamp arbitrary text to a single ≤48-char title line, ellipsizing at a word
 * boundary when one falls in the back half. Returns `''` for blank input.
 * This is the whole pipeline for MANUAL titles (the `rename` op) — user text
 * is never stripped or re-capitalized.
 */
export function clampThreadTitle(raw: string): string {
  const line = firstLine(raw);
  if (line.length <= TITLE_MAX_CHARS) return line;
  const hard = line.slice(0, TITLE_MAX_CHARS - 1);
  const lastSpace = hard.lastIndexOf(' ');
  const cut = lastSpace >= TITLE_MAX_CHARS / 2 ? hard.slice(0, lastSpace) : hard;
  return `${cut.trimEnd()}…`;
}

/**
 * Derive a tab title from a thread's first prompt: drop the markdown/filler
 * lead-in, keep the words that distinguish this thread. Stripping is only
 * adopted when the remainder still reads as a title (two-plus words, or one
 * long one) — otherwise the raw first line passes through untouched, so
 * greeting-only prompts and non-English prompts degrade to today's behavior.
 */
export function deriveThreadTitle(prompt: string): string {
  const line = firstLine(prompt);
  let stripped = line.replace(MARKDOWN_LEAD_RE, '');
  for (let pass = 0; pass < MAX_STRIP_PASSES; pass++) {
    const next = stripped.replace(FILLER_RE, '');
    if (next === stripped) break;
    stripped = next;
  }
  stripped = stripped.trim();
  const words = stripped.split(/\s+/).filter((w) => w !== '').length;
  const viable = stripped !== '' && (words >= 2 || stripped.length >= 12);
  if (!viable || stripped === line) return clampThreadTitle(line);
  return clampThreadTitle(stripped.charAt(0).toUpperCase() + stripped.slice(1));
}
