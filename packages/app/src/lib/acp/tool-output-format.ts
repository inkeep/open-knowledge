import { widenFenceLength } from '@inkeep/open-knowledge-core';

const FENCE_LINE = /^\s{0,3}(?:`{3,}|~{3,})/;
const HEADING = /^#{1,6}\s+\S/m;
const LIST_LINE = /^\s{0,3}(?:[-*+]|\d+[.)])\s+\S/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const MARKDOWN_DOC = /\.mdx?$/i;
const JSON_LIMIT = 20_000;
const JSON_PARSE_LIMIT = 200_000;

export type ToolOutputMode = 'markdown' | 'code' | 'auto';

export function toolOutputMode(call: {
  toolKind: string;
  locations: ReadonlyArray<{ path: string }>;
  diffs: ReadonlyArray<{ path: string }>;
}): ToolOutputMode {
  if (call.toolKind === 'execute') return 'code';
  const paths = [...call.locations, ...call.diffs].map((entry) => entry.path);
  if (paths.some((path) => MARKDOWN_DOC.test(path))) return 'markdown';
  if (paths.length > 0) return 'code';
  return 'auto';
}

export function looksLikeMarkdown(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return false;
  const lines = trimmed.split('\n');
  const fences = lines.filter((line) => FENCE_LINE.test(line)).length;
  if (fences > 0) return fences % 2 === 0;
  if (HEADING.test(trimmed)) return true;
  if (lines.filter((line) => LIST_LINE.test(line)).length >= 3) return true;
  return lines.some(
    (line, index) => TABLE_ROW.test(line) && TABLE_SEPARATOR.test(lines[index + 1] ?? ''),
  );
}

export function prettyJson(text: string): string | null {
  const trimmed = text.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return null;
  if (trimmed.length > JSON_PARSE_LIMIT) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const pretty = JSON.stringify(parsed, null, 2);
  return pretty.length > JSON_LIMIT ? `${pretty.slice(0, JSON_LIMIT)}…` : pretty;
}

export function jsonMarkdown(json: string): string {
  const fence = '`'.repeat(widenFenceLength('`', json));
  return `${fence}json\n${json}\n${fence}`;
}
