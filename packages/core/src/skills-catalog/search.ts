import { isRetiredPackListing } from '../constants/skills.ts';
import type { SkillSearchResult } from './schema.ts';
import { ownerOf, slug } from './source-fields.ts';

export function parseSkillsShSearch(json: unknown): SkillSearchResult[] {
  const skills = (json as { skills?: unknown } | null)?.skills;
  if (!Array.isArray(skills)) return [];
  const out: SkillSearchResult[] = [];
  for (const raw of skills) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const source = typeof r.source === 'string' && r.source ? r.source : undefined;
    const id = typeof r.id === 'string' && r.id ? r.id : source;
    if (!id || !source) continue;
    const name = typeof r.name === 'string' && r.name ? r.name : slug(id);
    if (isRetiredPackListing(name, source)) continue;
    out.push({
      id,
      name,
      source,
      description: typeof r.description === 'string' ? r.description : '',
      installs:
        Number.isInteger(r.installs) && (r.installs as number) >= 0 ? (r.installs as number) : null,
      publisher: ownerOf(source),
    });
  }
  return out;
}

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&apos;': "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos|#39|#x27);/g, (m) => HTML_ENTITIES[m] ?? m);
}

export function parseOpenGraph(html: string): {
  title?: string;
  description?: string;
  image?: string;
} {
  const out: { title?: string; description?: string; image?: string } = {};
  const metas = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of metas) {
    const prop = tag.match(/\bproperty\s*=\s*["'](og:[^"']+)["']/i)?.[1]?.toLowerCase();
    if (!prop) continue;
    const content = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1];
    if (content == null) continue;
    const value = decodeEntities(content);
    if (prop === 'og:title' && out.title == null) out.title = value;
    else if (prop === 'og:description' && out.description == null) out.description = value;
    else if (prop === 'og:image' && out.image == null) out.image = value;
  }
  return out;
}

export function parseGitHubRepoSearch(json: unknown): SkillSearchResult[] {
  const items = (json as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const out: SkillSearchResult[] = [];
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const fullName = typeof r.full_name === 'string' && r.full_name ? r.full_name : undefined;
    if (!fullName) continue;
    out.push({
      id: fullName,
      name: typeof r.name === 'string' && r.name ? r.name : slug(fullName),
      source: fullName,
      description: typeof r.description === 'string' ? r.description : '',
      installs: null,
      publisher: ownerOf(fullName),
    });
  }
  return out;
}
