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
  projectSkillContentDocName,
  SKILL_CONTENT_ROOT,
  skillLiveDocName,
} from '@inkeep/open-knowledge-core';

// `projectSkillContentDocName` + `skillLiveDocName` (and the `.ok/skills` root,
// `SKILL_CONTENT_ROOT`) are the SINGLE source of truth in core, shared with the
// server. Re-exported here so existing app call sites keep importing them from
// this module unchanged.
export { projectSkillContentDocName, skillLiveDocName };

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

/** A path inside a PROJECT skill's source dir (`.ok/skills/<name>/<relPath>`) — a
 *  nested content doc or asset. */
export function projectSkillFilePath(name: string, relPath: string): string {
  return `${SKILL_CONTENT_ROOT}/${name}/${relPath}`;
}

/**
 * Parse a project-skill `SKILL.md` content doc name back to its skill name, or
 * null when it isn't one. Lets the editor render the unified skill identity panel
 * for project skills (which open as content docs) the same as global skills.
 * Skill names are slash-free by grammar, so a nested path is rejected.
 */
export function parseProjectSkillContentDocName(docName: string): string | null {
  const prefix = `${SKILL_CONTENT_ROOT}/`;
  const suffix = '/SKILL';
  if (!docName.startsWith(prefix) || !docName.endsWith(suffix)) return null;
  const name = docName.slice(prefix.length, docName.length - suffix.length);
  return name && !name.includes('/') ? name : null;
}
