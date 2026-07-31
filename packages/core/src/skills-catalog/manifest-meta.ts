/**
 * The one SKILL.md `{ name, description }` extractor. Both the catalog adapter
 * reader (`adapters/shared.ts`) and the acquire parser (`acquire/parse.ts`) need
 * the same rule — frontmatter `name`/`description`, dir-name fallback, empty-name
 * guard — so it lives here once instead of drifting between the two.
 */

import { stripFrontmatter, unwrapFrontmatterFences } from '../extensions/frontmatter.ts';
import { parseFrontmatterYaml } from '../frontmatter/yaml-codec.ts';

/**
 * Extract `{ name, description }` from SKILL.md text. `name` falls back to
 * `dirName` when frontmatter is absent, malformed, or carries a blank name;
 * `description` defaults to `''`. Never throws — `parseFrontmatterYaml` degrades
 * malformed YAML rather than raising, so one bad skill stays degraded, not fatal.
 */
export function readSkillManifestMeta(
  skillMd: string,
  dirName: string,
): { name: string; description: string } {
  let name = dirName;
  let description = '';
  const { frontmatter: fenced } = stripFrontmatter(skillMd);
  if (fenced !== '') {
    const { map } = parseFrontmatterYaml(unwrapFrontmatterFences(fenced));
    const fmName = map?.name;
    const fmDesc = map?.description;
    if (typeof fmName === 'string' && fmName.trim() !== '') name = fmName;
    if (typeof fmDesc === 'string') description = fmDesc;
  }
  return { name, description };
}
