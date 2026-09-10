import { FRONTMATTER_RE, stripFrontmatter } from '../extensions/frontmatter.ts';
import { carriedEdgeEmpties, type DocEdgeEmpties } from '../markdown/doc-edge-blank-runs.ts';

const LEADING_BOUNDARY_RE = /^(?:\r?\n)+/;

function fragmentCarriesDocStartRun(fragmentBody: string): boolean {
  return carriedEdgeEmpties(fragmentBody).leading > 0;
}

export interface MergeBoundarySpace {
  project(text: string): string;
  unproject(merged: string, raw: string): string;
}

export function createMergeBoundarySpace(fragmentBody: string): MergeBoundarySpace {
  const carriesDocStartRun = fragmentCarriesDocStartRun(fragmentBody);
  return {
    project: (text) => projectMergeBoundarySpace(text, carriesDocStartRun),
    unproject: (merged, raw) => unprojectMergeBoundarySpace(merged, raw, carriesDocStartRun),
  };
}

export interface DocBoundarySplit {
  boundary: string;
  text: string;
}

export function splitLeadingDocBoundary(
  text: string,
  carriesDocStartRun: boolean,
): DocBoundarySplit {
  if (carriesDocStartRun) return { boundary: '', text };
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

export function projectMergeBoundarySpace(text: string, carriesDocStartRun: boolean): string {
  if (carriesDocStartRun) return text;
  const stripped = splitLeadingDocBoundary(text, carriesDocStartRun).text;
  if (stripFrontmatter(stripped).frontmatter === '') return stripped;
  return reattachLeadingDocBoundary(stripped, '\n');
}

export function unprojectMergeBoundarySpace(
  merged: string,
  raw: string,
  carriesDocStartRun: boolean,
): string {
  if (carriesDocStartRun) return merged;
  return reattachLeadingDocBoundary(
    splitLeadingDocBoundary(merged, carriesDocStartRun).text,
    splitLeadingDocBoundary(raw, carriesDocStartRun).boundary,
  );
}

export interface FmBoundarySlotSplit {
  slot: string;
  body: string;
}

export function splitFmBoundarySlot(frontmatter: string, body: string): FmBoundarySlotSplit {
  if (frontmatter === '') return { slot: '', body };
  const match = body.match(/^\r?\n/);
  if (!match) return { slot: '', body };
  return { slot: match[0], body: body.slice(match[0].length) };
}

export function bodyEdgeEmpties(text: string): DocEdgeEmpties {
  const { frontmatter, body } = stripFrontmatter(text);
  if (frontmatter === '') return carriedEdgeEmpties(text);
  const slotStripped = splitFmBoundarySlot(frontmatter, body).body;
  if (/^\n*$/.test(slotStripped)) return carriedEdgeEmpties(text);
  return carriedEdgeEmpties(slotStripped);
}

export function docEdgeRunsDiffer(a: string, b: string): boolean {
  const edgesA = bodyEdgeEmpties(a);
  const edgesB = bodyEdgeEmpties(b);
  return edgesA.leading !== edgesB.leading || edgesA.trailing !== edgesB.trailing;
}
