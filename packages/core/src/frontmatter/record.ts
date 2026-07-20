/**
 * Whole-document → raw frontmatter record parse — the read-side complement
 * to `parseFrontmatterYaml`.
 *
 * Open-shape readers (MCP enrichment metadata, managed `.md` files such as
 * SKILL.md, content tooling) need every key/value the document declared,
 * verbatim. `parseFrontmatterYaml` is deliberately NOT that: it validates
 * against `FrontmatterMapSchema` (the constrained editor-write value shapes)
 * and coerces on the way through (bare-key `null` → `''`, scalar array
 * elements → string), and a single out-of-shape value rejects the whole map.
 * This parse shares the canonical fence contract (`FRONTMATTER_RE` via
 * `stripFrontmatter` / `unwrapFrontmatterFences`) and the codec's
 * total-function discipline, but returns the parsed YAML mapping untouched.
 */
import { parseDocument } from 'yaml';
import { stripFrontmatter, unwrapFrontmatterFences } from '../extensions/frontmatter.ts';

/**
 * Parse a markdown document's YAML frontmatter into a raw key-value record.
 *
 * Returns `null` when the document has no frontmatter block, the block is
 * empty (`---\n---`), the YAML is malformed, or its top-level value is not a
 * mapping (scalar / sequence). Values are returned verbatim — no schema
 * validation or coercion.
 */
export function parseFrontmatterRecord(markdown: string): Record<string, unknown> | null {
  const { frontmatter } = stripFrontmatter(markdown);
  if (frontmatter === '') return null;
  let parsed: unknown;
  try {
    const doc = parseDocument(unwrapFrontmatterFences(frontmatter));
    if (doc.errors.length > 0) return null;
    // yaml@2's `toJS()` can throw even when `doc.errors` is empty (unresolved
    // aliases, the maxAliasCount resource-exhaustion guard) — same
    // total-function guard as `parseFrontmatterYaml`.
    parsed = doc.toJS();
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}
