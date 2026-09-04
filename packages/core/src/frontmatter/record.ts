import { parseDocument } from 'yaml';
import { stripFrontmatter, unwrapFrontmatterFences } from '../extensions/frontmatter.ts';

export function parseFrontmatterRecord(markdown: string): Record<string, unknown> | null {
  const { frontmatter } = stripFrontmatter(markdown);
  if (frontmatter === '') return null;
  let parsed: unknown;
  try {
    const doc = parseDocument(unwrapFrontmatterFences(frontmatter));
    if (doc.errors.length > 0) return null;
    parsed = doc.toJS();
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}
