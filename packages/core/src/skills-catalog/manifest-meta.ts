import { stripFrontmatter, unwrapFrontmatterFences } from '../extensions/frontmatter.ts';
import { parseFrontmatterYaml } from '../frontmatter/yaml-codec.ts';

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
