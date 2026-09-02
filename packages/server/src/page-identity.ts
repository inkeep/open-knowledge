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

export function extractPageTitle(content: string, filename: string): string {
  const { frontmatter, body } = stripFrontmatter(content);
  const title = extractFrontmatterScalar(frontmatter, 'title');
  if (title) return title;

  return extractFirstHeading(body) ?? filename;
}

export function extractFirstHeading(body: string): string | undefined {
  const headingMatch = body.match(/^# (.+)$/m);
  return headingMatch ? headingMatch[1].trim() : undefined;
}

const ICON_VALUE_LENGTH_CAP = 2048;

export function extractPageIcon(content: string): string | undefined {
  const { frontmatter } = stripFrontmatter(content);
  const icon = extractFrontmatterScalar(frontmatter, 'icon');
  if (!icon || icon.length > ICON_VALUE_LENGTH_CAP) return undefined;
  return icon;
}

const BLOCK_SCALAR_INDICATOR = /^[>|][+-]?\d*$/;

function extractSingleLineScalar(content: string, key: string): string | undefined {
  const { frontmatter } = stripFrontmatter(content);
  const value = extractFrontmatterScalar(frontmatter, key);
  if (!value || BLOCK_SCALAR_INDICATOR.test(value)) return undefined;
  return value;
}

export function extractPageDescription(content: string): string | undefined {
  return extractSingleLineScalar(content, 'description');
}

export function extractPageType(content: string): string | undefined {
  return extractSingleLineScalar(content, 'type');
}

export interface FrontmatterMetadata {
  cluster: string | undefined;
  category: string | undefined;
  tags: string[] | undefined;
}

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
