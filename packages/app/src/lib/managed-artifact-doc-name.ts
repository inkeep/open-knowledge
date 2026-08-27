/**
 * Builders for skill live-doc names. A GLOBAL skill is a managed-artifact doc
 * (`__skill__/global/<name>`); a PROJECT skill is a content doc at its real path
 * (`.ok/skills/<name>/SKILL`). These are real CRDT doc names opened as ordinary
 * editor tabs, so they follow the SAME convention as document doc names: the
 * canonical key is the raw/decoded string. `hashFromDocName` percent-encodes
 * that key per segment on the way into the hash and `docNameFromHash` decodes
 * it back — so build the name here raw. Encoding it a second time here would
 * round-trip to a different key than the tab/provider uses.
 *
 * Templates are content docs too — build their doc name with
 * `templateContentDocName` from `@inkeep/open-knowledge-core`, not here.
 */

import {
  parseProjectSkillBundleDoc,
  type SkillsListEntry,
  skillFileLiveDocName,
  skillLiveDocName,
  stripMdExt,
} from '@inkeep/open-knowledge-core';

export { skillLiveDocName };

// NOTE: there is intentionally no `skillDocName(scope, name)` builder. Project
// skills are CONTENT docs (`.ok/skills/<name>/SKILL`), not `__skill__/project/…`
// — so the only correct builder is `skillLiveDocName` (project → content doc,
// global → `__skill__/global/<name>`), re-exported above. A bare synthetic
// builder opened a phantom empty tab for project skills (round-trip data loss).

/**
 * Live CRDT doc name for a skill LIST ENTRY. A project entry is a content doc
 * at its REAL path (ext-less) — `.ok/skills/<name>/SKILL` for store skills,
 * `.claude/skills/<name>/SKILL` (etc.) for in-place editor-dir skills
 * — so when an entry is at hand, use this instead of the store-hardcoded
 * `skillLiveDocName`. Global entries keep the managed-artifact scheme.
 */
export function skillEntryLiveDocName(
  skill: Pick<SkillsListEntry, 'scope' | 'name' | 'path' | 'canonicalPath' | 'hostQualifier'>,
): string {
  return skill.scope === 'project'
    ? stripMdExt(skillEntryDocPath(skill))
    : // `hostQualifier` = a non-default same-named GLOBAL bundle: its doc is
      // `__skill__/global/<name>@<host>`, so the two bundles keep separate
      // tabs and separate write-back paths instead of collapsing onto one doc.
      skillLiveDocName(skill.scope, skill.name, skill.hostQualifier);
}

/**
 * The path a PROJECT entry's docs are ADDRESSED by. `path` is where the bundle
 * is mounted, which for a symlinked skill dir is an alias: the document index
 * holds one page per inode under the canonical name, so a tab opened at the
 * alias has no page and is pruned by the next page-list sync (skill flickers
 * open, vanishes, surface falls back to Files). `canonicalPath` is the server's
 * resolution of that alias — prefer it wherever a doc NAME is minted, and leave
 * `path` to the on-disk questions (install targets, reveal, host wiring).
 */
function skillEntryDocPath(skill: Pick<SkillsListEntry, 'path' | 'canonicalPath'>): string {
  return skill.canonicalPath ?? skill.path;
}

/** Per-bundle-file analogue of {@link skillEntryLiveDocName}: the live doc name
 *  for `rel` (e.g. `references/patterns.md`) inside the entry's real dir. */
export function skillEntryFileLiveDocName(
  skill: Pick<SkillsListEntry, 'scope' | 'name' | 'path' | 'canonicalPath' | 'hostQualifier'>,
  rel: string,
): string {
  if (skill.scope !== 'project')
    return skillFileLiveDocName(skill.scope, skill.name, rel, skill.hostQualifier);
  const dir = skillEntryDocPath(skill).replace(/\/SKILL\.mdx?$/i, '');
  return `${dir}/${stripMdExt(rel)}`;
}

/**
 * Parse a project-skill `SKILL.md` content doc name back to its skill name, or
 * null when it isn't one. Lets the editor render the unified skill identity panel
 * for project skills (which open as content docs) the same as global skills.
 * Shape-matched via the shared core parser, so it covers BOTH the `.ok/skills`
 * store AND in-place editor-dir skills (`.claude/skills/<name>/SKILL`, …).
 * Skill names are slash-free by grammar, so a nested path is rejected.
 */
export function parseProjectSkillContentDocName(docName: string): string | null {
  const parsed = parseProjectSkillBundleDoc(docName);
  return parsed?.kind === 'skill' ? parsed.name : null;
}
