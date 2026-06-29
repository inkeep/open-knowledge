
export const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?\r?\n)?---[ \t]*(\r?\n|$)/;

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

export function unwrapFrontmatterFences(fenced: string): string {
  if (fenced === '') return '';
  const match = fenced.match(FRONTMATTER_RE);
  if (!match) return fenced;
  const body = match[1] ?? '';
  return body.replace(/\r?\n$/, '');
}
