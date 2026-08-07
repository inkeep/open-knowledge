/**
 * Defensive parsers for skill discovery responses. Both upstreams are consumed
 * without a stable contract — skills.sh `/api/search` is undocumented (the
 * keyless endpoint its own CLI uses) and the GitHub fallback is a generic repo
 * search — so shape drift (missing fields, non-array payloads) degrades a row to
 * skipped rather than throwing. The server handler wraps these; keeping them pure
 * makes the normalization unit-testable without a network round-trip.
 */

import { isRetiredPackListing } from '../constants/skills.ts';
import type { SkillSearchResult } from './schema.ts';
import { ownerOf, slug } from './source-fields.ts';

/** Normalize skills.sh `/api/search` JSON (`{ skills: [{ id, name, source, installs }] }`). */
export function parseSkillsShSearch(json: unknown): SkillSearchResult[] {
  const skills = (json as { skills?: unknown } | null)?.skills;
  if (!Array.isArray(skills)) return [];
  const out: SkillSearchResult[] = [];
  for (const raw of skills) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const source = typeof r.source === 'string' && r.source ? r.source : undefined;
    const id = typeof r.id === 'string' && r.id ? r.id : source;
    // A row without both a usable id and source cannot be represented in the catalog.
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

/**
 * Extract the Open Graph tags the skill-detail modal renders. The skills.sh page
 * can't be iframed (`x-frame-options: DENY`), so its `og:image` — a 1200×630
 * rendered card — is the "page preview", and `og:description` carries the skill's
 * real description (skills.sh search JSON has none). Kept pure + tag-order
 * tolerant (`property`/`content` in either order); a missing tag → undefined
 * rather than throwing, since the upstream HTML has no contract.
 */
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

/** Normalize GitHub `search/repositories` JSON → degraded results (no install counts). */
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
