/**
 * Heuristic: does a text/plain clipboard payload look like markdown?
 *
 * Follows Outline's signal-count pattern. We look for distinctive markdown
 * signals — fenced code (backtick + tilde), ATX/setext headings, bullet
 * markers, latex dollar pairs, pipe-delimited tables, literal links,
 * blockquotes, inline code, paired emphasis (strong + single emphasis +
 * strikethrough), JSX open tags (capitalized + lowercase-with-attr), raw
 * HTML inline, and CommonMark backslash escapes. The threshold scales
 * with line count: `min(3, floor(lineCount / 5))`, floored at 1.
 *
 * The heuristic is intentionally coarse: small snippets need at most one
 * signal to count, long snippets need up to three. Prose with occasional
 * stars stays below threshold on long inputs; very short snippets that
 * carry distinctive emphasis markers (`*foo*`, `_foo_`) tip into "looks
 * like markdown" by design — the user typed authoring markup, even if
 * a single instance, and the dispatcher routes them through the markdown
 * parser so source-form attrs (`sourceDelimiter`) survive.
 */

const FENCE_RE = /^```/m;
const HEADING_RE = /^#{1,6} /m;
const BULLET_RE = /^[-*+] /m;
const NUMBERED_RE = /^\d+[.)] /m;
// Inline link: [label](url). Matches are strong signals because the
// shape is unusual in plain prose.
const INLINE_LINK_RE = /\[[^\]\n]+\]\([^)\n]+\)/;
// GFM table row: at least one `|` at the start, `|` at the end, and a
// separator row like `|---|---|` or `| --- | --- |`.
const TABLE_ROW_RE = /^\|.*\|$/m;
const TABLE_SEPARATOR_RE = /^\|?\s*(:?-+:?)(\s*\|\s*:?-+:?)+\s*\|?$/m;
// LaTeX math: `$$...$$` block or `$...$` inline with at least two $ pairs.
const MATH_BLOCK_RE = /\$\$[\s\S]+?\$\$/;
// Blockquote: line beginning with `> ` (one of the most common AI-chat
// copy-button shapes; also frequent in cross-machine markdown transport).
const BLOCKQUOTE_RE = /^> /m;
// Inline code: backtick-wrapped span. Distinctive enough that a single
// match is meaningful, even in short prose.
const INLINE_CODE_RE = /`[^`\n]+`/;
// Paired strong / strikethrough: `**bold**` / `__bold__` / `~~strike~~`.
// Three alternatives mapped to one signal — distinct from incidental
// single `*`/`_`/`~` characters in prose.
const STRONG_STAR_RE = /\*\*[^*\n]+\*\*/;
const STRONG_UNDER_RE = /__[^_\n]+__/;
const STRIKE_RE = /~~[^~\n]+~~/;
// Capitalized JSX open tag: `<Callout`, `<Accordion`, `<Image`, etc.
// Catches cross-machine paste (single-line `<Callout type="note">…`
// shared via email/Slack as raw markdown).
const JSX_CAPITAL_OPEN_RE = /<[A-Z]\w*[\s/>]/;
// Lowercase JSX/HTML with attribute: `<img src="x">`, `<a href="…">`.
// Needed for the `<img/>` JSX regression and for any HTML inline that
// carries attributes — distinct from raw-HTML-inline which requires a
// matching closing tag.
const JSX_LOWERCASE_ATTR_RE = /<[a-z]+\s+\w+="[^"]*"/;
// Raw HTML inline: `<u>foo</u>`, `<mark>…</mark>`. Requires BOTH opening
// AND closing tag on the same line (rare in non-markdown prose).
const HTML_INLINE_RE = /<[a-z]+>[^<\n]*<\/[a-z]+>/;

// Setext heading underline. `Title\n=====` (H1) or `Subtitle\n---`
// (H2). The `^.+\n[=-]+$` shape requires a non-empty content line directly
// followed by an underline composed solely of `=` or `-` chars. With the
// `m` flag, `$` matches end-of-line, so the underline must end the line.
const SETEXT_RE = /^.+\n[=-]+$/m;
// Single-asterisk emphasis (`*emphasis*`). Inner second-char and
// last-non-marker chars use `[^*\s\n]` (not `\S`) so `**bold**` does NOT
// match — a literal `*` after the opener would be a strong delimiter, not
// the start of single-asterisk content. Without that exclusion, `**bold**`
// would double-count (1 signal from STRONG_STAR_RE + 1 from this regex).
// The leading `(^|\s)` anchors to a word boundary so `snake*case` style
// usage stays unmatched. The trailing `(\s|$)` mirrors the leading anchor.
const SINGLE_STAR_EM_RE = /(^|\s)\*[^*\s\n][^*\n]*[^*\s\n]\*(\s|$)/m;
// Single-underscore emphasis (`_emphasis_`). Mirrors SINGLE_STAR_EM
// with `_` as delimiter. Won't match `__bold__` (excluded by inner char
// class) or `snake_case_var` (no surrounding whitespace).
const SINGLE_UNDER_EM_RE = /(^|\s)_[^_\s\n][^_\n]*[^_\s\n]_(\s|$)/m;
// Tilde fenced code (`~~~js\ncode\n~~~`). CommonMark §4.5 admits
// both backtick and tilde fences; this catches the tilde flavor that
// FENCE_RE (backtick-only) misses.
const TILDE_FENCE_RE = /^~~~/m;
// CommonMark backslash escape (§2.4). A literal `\` followed by an
// ASCII-punct char that markdown treats as escapable. Strong signal that
// the user authored markdown — prose almost never contains `\*`, `\_`,
// `\#`, etc. The character class mirrors the CommonMark §2.4 escapable
// punct set: ``\`*_{}[]<>()#+-.!|``.
const BACKSLASH_ESCAPE_RE = /\\[\\`*_{}[\]<>()#+\-.!|]/;

// Backpressure ceiling for the heuristic. Mirrors `HTML_MAX_BYTES = 5MB`
// in `html-to-mdast.ts` — text/plain payloads above this size are sampled
// rather than scanned end-to-end. 18 linear regex tests + `text.split('\n')`
// on a multi-MB log file would breach the 250ms paste budget; sampling
// head + tail keeps the heuristic O(constant) without losing detection
// for the common case (markdown content typically front-loaded with
// headers / code blocks).
const HEURISTIC_SAMPLE_THRESHOLD = 256 * 1024;
const HEURISTIC_SAMPLE_HALF = 32 * 1024;

function sampleForHeuristic(text: string): string {
  if (text.length <= HEURISTIC_SAMPLE_THRESHOLD) return text;
  return `${text.slice(0, HEURISTIC_SAMPLE_HALF)}\n${text.slice(-HEURISTIC_SAMPLE_HALF)}`;
}

export function isMarkdown(text: string): boolean {
  if (!text) return false;
  const sample = sampleForHeuristic(text);
  let signals = 0;
  if (FENCE_RE.test(sample)) signals++;
  if (HEADING_RE.test(sample)) signals++;
  if (BULLET_RE.test(sample)) signals++;
  if (NUMBERED_RE.test(sample)) signals++;
  if (INLINE_LINK_RE.test(sample)) signals++;
  if (TABLE_ROW_RE.test(sample) && TABLE_SEPARATOR_RE.test(sample)) signals++;
  if (MATH_BLOCK_RE.test(sample)) signals++;
  if (BLOCKQUOTE_RE.test(sample)) signals++;
  if (INLINE_CODE_RE.test(sample)) signals++;
  if (STRONG_STAR_RE.test(sample) || STRONG_UNDER_RE.test(sample) || STRIKE_RE.test(sample))
    signals++;
  if (JSX_CAPITAL_OPEN_RE.test(sample)) signals++;
  if (JSX_LOWERCASE_ATTR_RE.test(sample)) signals++;
  if (HTML_INLINE_RE.test(sample)) signals++;
  if (SETEXT_RE.test(sample)) signals++;
  if (SINGLE_STAR_EM_RE.test(sample)) signals++;
  if (SINGLE_UNDER_EM_RE.test(sample)) signals++;
  if (TILDE_FENCE_RE.test(sample)) signals++;
  if (BACKSLASH_ESCAPE_RE.test(sample)) signals++;

  const lineCount = sample.split('\n').length;
  const threshold = Math.min(3, Math.floor(lineCount / 5));
  return signals >= Math.max(1, threshold);
}
