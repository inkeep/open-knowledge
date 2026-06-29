const FENCE_RE = /^```/m;
const HEADING_RE = /^#{1,6} /m;
const BULLET_RE = /^[-*+] /m;
const NUMBERED_RE = /^\d+[.)] /m;
const INLINE_LINK_RE = /\[[^\]\n]+\]\([^)\n]+\)/;
const TABLE_ROW_RE = /^\|.*\|$/m;
const TABLE_SEPARATOR_RE = /^\|?\s*(:?-+:?)(\s*\|\s*:?-+:?)+\s*\|?$/m;
const MATH_BLOCK_RE = /\$\$[\s\S]+?\$\$/;
const BLOCKQUOTE_RE = /^> /m;
const INLINE_CODE_RE = /`[^`\n]+`/;
const STRONG_STAR_RE = /\*\*[^*\n]+\*\*/;
const STRONG_UNDER_RE = /__[^_\n]+__/;
const STRIKE_RE = /~~[^~\n]+~~/;
const JSX_CAPITAL_OPEN_RE = /<[A-Z]\w*[\s/>]/;
const JSX_LOWERCASE_ATTR_RE = /<[a-z]+\s+\w+="[^"]*"/;
const HTML_INLINE_RE = /<[a-z]+>[^<\n]*<\/[a-z]+>/;

const SETEXT_RE = /^.+\n[=-]+$/m;
const SINGLE_STAR_EM_RE = /(^|\s)\*[^*\s\n][^*\n]*[^*\s\n]\*(\s|$)/m;
const SINGLE_UNDER_EM_RE = /(^|\s)_[^_\s\n][^_\n]*[^_\s\n]_(\s|$)/m;
const TILDE_FENCE_RE = /^~~~/m;
const BACKSLASH_ESCAPE_RE = /\\[\\`*_{}[\]<>()#+\-.!|]/;

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
