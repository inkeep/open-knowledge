/**
 * Frontmatter strip/prepend utilities for markdown round-trip.
 *
 * marked treats `---` as a thematic break (horizontal rule).
 * Frontmatter must be regex-stripped before parsing and re-prepended after serialization.
 *
 * Fence lines tolerate trailing spaces/tabs, matching
 * micromark-extension-frontmatter (the engine behind remark-frontmatter),
 * which consumes optional whitespace after both fence sequences; leading
 * whitespace before the opening fence still disqualifies the block. This
 * tolerance is load-bearing: recognition must agree with the bridge
 * tolerance set in `bridge/normalize.ts` about fence-line trailing
 * whitespace — an in-tolerance Y.Text edit must never flip FM-region
 * recognition (partition invariance).
 */

export const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?\r?\n)?---[ \t]*(\r?\n|$)/;

/**
 * Line-scoped shape of the same fence contract, for code that walks lines
 * (CodeMirror decorations, outline navigation): a line that IS a fence —
 * `---` plus optional trailing spaces/tabs, nothing else. Must stay in
 * agreement with FRONTMATTER_RE.
 */
export const FM_FENCE_LINE_RE = /^---[ \t]*$/;

export function stripFrontmatter(markdown: string): { frontmatter: string; body: string } {
  const match = markdown.match(FRONTMATTER_RE);
  if (match) {
    return {
      frontmatter: match[0],
      body: markdown.slice(match[0].length),
    };
  }
  return { frontmatter: '', body: markdown };
}

export function prependFrontmatter(frontmatter: string, body: string): string {
  if (!frontmatter) return body;
  return frontmatter + body;
}

/**
 * Strip the leading and trailing `---` fences from a `stripFrontmatter` result.
 * Inverse of `withFences` from `frontmatter/yaml-codec.ts`. Returns the YAML
 * body that `parseFrontmatterYaml` expects (no fences). Empty input → empty.
 *
 * Handles the empty-block case `---\n---\n` (and CRLF variants) by reusing
 * `FRONTMATTER_RE`'s body capture group instead of stripping fences in two
 * passes — the latter fails when the body capture is empty because the
 * trailing-fence regex needs a preceding `\n` that isn't there.
 */
export function unwrapFrontmatterFences(fenced: string): string {
  if (fenced === '') return '';
  const match = fenced.match(FRONTMATTER_RE);
  if (!match) return fenced;
  const body = match[1] ?? '';
  return body.replace(/\r?\n$/, '');
}
