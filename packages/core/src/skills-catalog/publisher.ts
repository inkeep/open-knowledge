import { isRetiredPackListing } from '../constants/skills.ts';
import type { SkillSearchResult } from './schema.ts';
import { ownerOf } from './source-fields.ts';

const ROW = /href="\/([^"/]+)\/([^"/]+)\/([^"/?#]+)"([\s\S]*?)<\/a>/g;
const COUNT = /<span[^>]*font-mono[^>]*>\s*([\d,]+)\s*<\/span>/;

export function parseSkillsShPublisherPage(html: string, source: string): SkillSearchResult[] {
  const byId = new Map<string, SkillSearchResult>();
  ROW.lastIndex = 0;
  for (let m = ROW.exec(html); m !== null; m = ROW.exec(html)) {
    const [, owner, repo, skillId, rest] = m;
    if (!owner || !repo || !skillId || !rest) continue;
    if (`${owner}/${repo}` !== source) continue;
    if (isRetiredPackListing(skillId, source)) continue;
    const installs = Number.parseInt(COUNT.exec(rest)?.[1]?.replaceAll(',', '') ?? '', 10);
    if (!Number.isInteger(installs) || installs < 0) continue;
    const id = `${source}/${skillId}`;
    if (byId.has(id)) continue;
    byId.set(id, {
      id,
      name: skillId,
      source,
      description: '',
      installs,
      publisher: ownerOf(source),
    });
  }
  return [...byId.values()].sort((a, b) => (b.installs ?? -1) - (a.installs ?? -1));
}
