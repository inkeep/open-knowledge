import {
  stripFrontmatter,
  toWikiLinkSlug,
  unwrapFrontmatterFences,
} from '@inkeep/open-knowledge-core';

export interface PageIdentity {
  docName: string;
  title: string;
  aliases: string[];
  matchLabels: string[];
  normalizedMatchLabels: string[];
}

function splitFrontmatterLines(frontmatter: string): string[] {
  if (!frontmatter) return [];
  // Unwrap via the core helper rather than local fence-strip replaces so the
  // fence shape (incl. trailing-whitespace tolerance) stays owned by core.
  return unwrapFrontmatterFences(frontmatter).split(/\r?\n/);
}

function normalizeFrontmatterScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function extractFrontmatterScalar(frontmatter: string, key: string): string | null {
  const prefix = `${key}:`;
  for (const line of splitFrontmatterLines(frontmatter)) {
    if (!line.startsWith(prefix)) continue;
    const value = normalizeFrontmatterScalar(line.slice(prefix.length));
    return value || null;
  }
  return null;
}

function parseInlineAliases(value: string): string[] {
  const items: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (const char of value) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === ',') {
      const normalized = normalizeFrontmatterScalar(current);
      if (normalized) items.push(normalized);
      current = '';
      continue;
    }

    current += char;
  }

  const normalized = normalizeFrontmatterScalar(current);
  if (normalized) items.push(normalized);
  return items;
}

function dedupeExact(values: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function extractPageAliases(content: string): string[] {
  const { frontmatter } = stripFrontmatter(content);
  if (!frontmatter) return [];

  const lines = splitFrontmatterLines(frontmatter);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(/^aliases:\s*(.*)$/);
    if (!match) continue;

    const value = match[1]?.trim() ?? '';
    if (value) {
      if (value.startsWith('[') && value.endsWith(']')) {
        return dedupeExact(parseInlineAliases(value.slice(1, -1)));
      }
      const alias = normalizeFrontmatterScalar(value);
      return alias ? [alias] : [];
    }

    const aliases: string[] = [];
    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      const nextLine = lines[nextIndex];
      if (!nextLine?.trim()) continue;
      if (/^\s*-\s+/.test(nextLine)) {
        const alias = normalizeFrontmatterScalar(nextLine.replace(/^\s*-\s+/, ''));
        if (alias) aliases.push(alias);
        continue;
      }
      if (/^[^\s][^:]*:\s*/.test(nextLine)) break;
      break;
    }
    return dedupeExact(aliases);
  }

  return [];
}

/**
 * Extract a human-readable title from a markdown file's content.
 *
 * Priority:
 *  1. `title:` field in YAML frontmatter (between leading `---` delimiters)
 *  2. First `# heading` line in the file body
 *  3. filename (without extension, as provided by the caller)
 */
export function extractPageTitle(content: string, filename: string): string {
  const { frontmatter, body } = stripFrontmatter(content);
  const title = extractFrontmatterScalar(frontmatter, 'title');
  if (title) return title;

  const headingMatch = body.match(/^# (.+)$/m);
  if (headingMatch) {
    return headingMatch[1].trim();
  }

  return filename;
}

/**
 * Extract the raw `icon:` scalar from a markdown file's frontmatter, or
 * `undefined` when absent / blank. The classification step (emoji vs.
 * URL vs. content-relative path vs. unsupported) happens client-side —
 * the server ships the unvalidated string. Kept symmetric with
 * `extractPageTitle`'s zero-dependency YAML walk so `handlePages` can
 * read both from the same `readFileSync` without pulling in a YAML
 * parser.
 */
/** Mirrors `MAX_VALUE_LENGTH` in `packages/app/src/components/page-header-utils.ts`
 * and `.max(2048)` on `PageEntrySchema.icon`. Server-side cap is the
 * load-bearing one: `successResponse` runs `safeParse` on every `/api/pages`
 * emit, and an oversized scalar on a single doc would 500 the entire
 * listing — degrading the file tree, wiki-link resolution cache, search
 * candidates, and the chip-icon cache for every other doc.
 */
const ICON_VALUE_LENGTH_CAP = 2048;

export function extractPageIcon(content: string): string | undefined {
  const { frontmatter } = stripFrontmatter(content);
  const icon = extractFrontmatterScalar(frontmatter, 'icon');
  if (!icon || icon.length > ICON_VALUE_LENGTH_CAP) return undefined;
  return icon;
}

export interface FrontmatterMetadata {
  cluster: string | undefined;
  category: string | undefined;
  tags: string[] | undefined;
}

/**
 * Parse frontmatter metadata fields relevant to graph display.
 * Accepts the raw YAML string (with or without `---` delimiters).
 * Uses regex-based extraction — no yaml dependency.
 */
export function parseFrontmatterMetadata(rawYaml: string): FrontmatterMetadata {
  if (!rawYaml?.trim()) {
    return { cluster: undefined, category: undefined, tags: undefined };
  }

  const cluster = extractFrontmatterScalar(rawYaml, 'cluster') ?? undefined;
  const category = extractFrontmatterScalar(rawYaml, 'category') ?? undefined;
  const tags = extractFrontmatterArray(rawYaml, 'tags');

  return { cluster, category, tags };
}

function extractFrontmatterArray(frontmatter: string, key: string): string[] | undefined {
  const prefix = `${key}:`;
  const lines = splitFrontmatterLines(frontmatter);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line?.startsWith(prefix)) continue;

    const value = line.slice(prefix.length).trim();
    if (value) {
      if (value.startsWith('[') && value.endsWith(']')) {
        const items = parseInlineAliases(value.slice(1, -1));
        return items.length > 0 ? items : undefined;
      }
      const scalar = normalizeFrontmatterScalar(value);
      return scalar ? [scalar] : undefined;
    }

    const items: string[] = [];
    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      const nextLine = lines[nextIndex];
      if (!nextLine?.trim()) continue;
      if (/^\s*-\s+/.test(nextLine)) {
        const item = normalizeFrontmatterScalar(nextLine.replace(/^\s*-\s+/, ''));
        if (item) items.push(item);
        continue;
      }
      if (/^[^\s][^:]*:\s*/.test(nextLine)) break;
      break;
    }
    return items.length > 0 ? items : undefined;
  }

  return undefined;
}

export function extractPageIdentity(content: string, docName: string): PageIdentity {
  const title = extractPageTitle(content, docName);
  const aliases = extractPageAliases(content);
  const matchLabels = dedupeExact([title, ...aliases]);

  const normalizedMatchLabels: string[] = [];
  const seenSlugs = new Set<string>();
  for (const label of matchLabels) {
    const slug = toWikiLinkSlug(label);
    if (!slug || seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    normalizedMatchLabels.push(slug);
  }

  return {
    docName,
    title,
    aliases,
    matchLabels,
    normalizedMatchLabels,
  };
}
