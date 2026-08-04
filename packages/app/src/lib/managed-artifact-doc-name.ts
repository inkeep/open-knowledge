/**
 * Builders for managed-artifact doc names — a skill (`__skill__/<scope>/<name>`)
 * or a template (`__template__/<folderRel>/<name>`). These are real CRDT doc
 * names opened as ordinary editor tabs (via `openDocument`), so they follow the
 * SAME convention as document doc names: the canonical key is the raw/decoded
 * string. `hashFromDocName` builds the `#/…` hash without encoding (the browser
 * encodes the URL); `docNameFromHash` decodes it back — so a builder that
 * encoded here would round-trip to a different key than the tab/provider uses.
 *
 * Parsing the other direction is `parseManagedArtifactName` from
 * `@inkeep/open-knowledge-core` (shared with the server). Skill/template names
 * are slash-free by grammar; template folders carry their own `/` separators,
 * which are structural and belong in the doc name verbatim.
 */

import {
  MANAGED_ARTIFACT_PREFIX_TEMPLATE,
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
 * The CRDT doc name for a template — folder-addressed
 * (`__template__/<folderRel>/<name>`, `folder` empty for the project root).
 */
export function templateDocName(folder: string, name: string): string {
  const trimmed = folder.replace(/^\/+|\/+$/g, '');
  return `${MANAGED_ARTIFACT_PREFIX_TEMPLATE}${trimmed ? `${trimmed}/` : ''}${name}`;
}

/**
 * Live CRDT doc name for a skill LIST ENTRY. A project entry is a content doc
 * at its REAL path (ext-less) — `.ok/skills/<name>/SKILL` for store skills,
 * `.claude/skills/<name>/SKILL` (etc.) for in-place editor-dir skills
 * — so when an entry is at hand, use this instead of the store-hardcoded
 * `skillLiveDocName`. Global entries keep the managed-artifact scheme.
 */
export function skillEntryLiveDocName(
  skill: Pick<SkillsListEntry, 'scope' | 'name' | 'path'>,
): string {
  return skill.scope === 'project'
    ? stripMdExt(skill.path)
    : skillLiveDocName(skill.scope, skill.name);
}

/** Per-bundle-file analogue of {@link skillEntryLiveDocName}: the live doc name
 *  for `rel` (e.g. `references/patterns.md`) inside the entry's real dir. */
export function skillEntryFileLiveDocName(
  skill: Pick<SkillsListEntry, 'scope' | 'name' | 'path'>,
  rel: string,
): string {
  if (skill.scope !== 'project') return skillFileLiveDocName(skill.scope, skill.name, rel);
  const dir = skill.path.replace(/\/SKILL\.mdx?$/i, '');
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
