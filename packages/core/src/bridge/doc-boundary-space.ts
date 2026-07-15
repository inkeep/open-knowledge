
import { FRONTMATTER_RE, stripFrontmatter } from '../extensions/frontmatter.ts';

const LEADING_BOUNDARY_RE = /^(?:\r?\n)+/;

export interface DocBoundarySplit {
  boundary: string;
  text: string;
}

export function splitLeadingDocBoundary(text: string): DocBoundarySplit {
  const { frontmatter, body } = stripFrontmatter(text);
  const match = body.match(LEADING_BOUNDARY_RE);
  if (!match) return { boundary: '', text };
  const strippedBody = body.slice(match[0].length);
  if (frontmatter === '' && FRONTMATTER_RE.test(strippedBody)) {
    return { boundary: '', text };
  }
  return { boundary: match[0], text: frontmatter + strippedBody };
}

export function reattachLeadingDocBoundary(text: string, boundary: string): string {
  if (boundary === '') return text;
  const { frontmatter, body } = stripFrontmatter(text);
  return frontmatter + boundary + body;
}

export function projectMergeBoundarySpace(text: string): string {
  const stripped = splitLeadingDocBoundary(text).text;
  if (stripFrontmatter(stripped).frontmatter === '') return stripped;
  return reattachLeadingDocBoundary(stripped, '\n');
}
