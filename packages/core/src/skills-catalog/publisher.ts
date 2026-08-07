/**
 * Parser for a skills.sh publisher page (`skills.sh/<owner>/<repo>`) — every
 * skill one publisher lists, with its install count.
 *
 * Exists because neither discovery source answers "what has this publisher
 * published, and how popular is each": `/api/search` is fuzzy and returns other
 * publishers' skills interleaved while missing some of the named one's, and a
 * repository enumeration knows nothing about installs. The publisher page is
 * the only complete listing, and unlike the front page it carries no RSC card
 * payload — the counts exist solely in rendered markup, so this reads the
 * markup.
 *
 * Pure (no fetch) so it's unit-testable against a saved fixture. Defensive like
 * the sibling `parseSkillsShLeaderboard`: a row that doesn't yield both a skill
 * id and an integer count is skipped rather than throwing, and a wholesale
 * format change parses to `[]` for the caller to degrade on.
 */

import { isRetiredPackListing } from '../constants/skills.ts';
import type { SkillSearchResult } from './schema.ts';
import { ownerOf } from './source-fields.ts';

/**
 * One listing row. Anchored on the row's own href (`/<owner>/<repo>/<skill>`)
 * rather than on the heading text, because the href is the identifier the rest
 * of the catalog keys on and it survives a heading restyle. `[^>]*?` between the
 * two captures keeps the match inside a single anchor: `[\s\S]*?` would let a
 * row with no count borrow the next row's number.
 */
const ROW = /href="\/([^"/]+)\/([^"/]+)\/([^"/?#]+)"([\s\S]*?)<\/a>/g;
/** The install count inside a row: the first bare integer in a `font-mono` span. */
const COUNT = /<span[^>]*font-mono[^>]*>\s*([\d,]+)\s*<\/span>/;

/**
 * Parse a publisher page into `SkillSearchResult`s ordered by install count
 * (most first) — the same shape the search and leaderboard parsers return, so
 * one card renders all three.
 *
 * `source` is the publisher being read (`owner/repo`); rows pointing at any
 * other publisher are ignored, so a "related skills" module or a footer link
 * can't smuggle a foreign skill into the list. Descriptions come back empty:
 * the page doesn't carry them, and inventing one would be worse than the blank
 * the card already handles.
 */
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
