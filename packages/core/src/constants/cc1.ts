export const SYSTEM_DOC_NAME = '__system__';
export const CC1_CONTRACT_VERSION = 1;

/**
 * Synthetic Hocuspocus document name for the project-scope config file.
 * Admitted Y.Text-only at boot via `hocuspocus.openDirectConnection()`.
 * Bridges bypass; agent-session bookkeeping skips. Extending the
 * admission set requires explicit re-decision.
 */
export const CONFIG_DOC_NAME_PROJECT = '__config__/project';

/**
 * Synthetic Hocuspocus document name for the user-global config file.
 * Same admission shape as `CONFIG_DOC_NAME_PROJECT`, lifetime per
 * server instance.
 */
export const CONFIG_DOC_NAME_USER = '__user__/config.yml';

/**
 * Synthetic Hocuspocus document name for the project-local config file
 * at `<projectDir>/.ok/local/config.yml` — gitignored, per-machine,
 * per-project. Holds preferences a teammate's machine should never
 * propagate via git (e.g. `autoSync.enabled`).
 */
export const CONFIG_DOC_NAME_PROJECT_LOCAL = '__local__/project';

/**
 * Synthetic Hocuspocus document name for the project-root `.okignore`.
 * Y.Text-only (raw text body — no YAML / no `ConfigSchema`). Body maps
 * 1:1 to the on-disk `<contentDir>/.okignore`. The Settings list editor
 * parses lines for display and round-trips them byte-faithful so user
 * comments and blank lines survive.
 *
 * Public contract — agents and scripts may address this doc by name.
 * Renaming is a 1-way door.
 */
export const CONFIG_DOC_NAME_OKIGNORE = '__config__/okignore';

/**
 * Frozen tuple of every well-known config doc name. The `isConfigDoc`
 * predicate gates membership; the admission set is intentionally bounded
 * (STOP rule: any addition requires explicit
 * re-decision).
 */
export const CONFIG_DOC_NAMES = Object.freeze([
  CONFIG_DOC_NAME_PROJECT,
  CONFIG_DOC_NAME_PROJECT_LOCAL,
  CONFIG_DOC_NAME_USER,
  CONFIG_DOC_NAME_OKIGNORE,
] as const);
export type ConfigDocName = (typeof CONFIG_DOC_NAMES)[number];

/**
 * Managed-artifact (skill / template) synthetic doc-name namespaces.
 *
 * Unlike config docs (a bounded frozen set), managed-artifact names are OPEN —
 * one synthetic doc per skill/template — so membership is PREFIX-based, not
 * set-membership. The grammar is identical to the client URL fragment in
 * `app/src/lib/doc-hash.ts` (`__skill__/<scope>/<name>`) so a deep link and the
 * server doc name are the same string.
 *
 * Managed-artifact docs are a THIRD doc class distinct from system/config docs:
 * they are excluded from the document tree / search / create-page (like
 * system+config docs) BUT the observer bridge runs for them (unlike config docs,
 * which are Y.Text-only) so they get full WYSIWYG+source editing. See
 * `server/src/managed-artifact-persistence.ts`.
 */
export const MANAGED_ARTIFACT_PREFIX_SKILL = '__skill__/';
export const MANAGED_ARTIFACT_PREFIX_TEMPLATE = '__template__/';

/**
 * Canonical skill/managed-artifact scope values — the single source for the
 * `global | project` axis. `cc1.ts` imports nothing, so it is the correct
 * lowest layer to own this; the wire schemas (`SkillScopeSchema`,
 * `InstalledSkillScopeSchema`) and every MCP tool's `scope` arg derive from it
 * rather than re-declaring the tuple. Order is wire-irrelevant (enum membership,
 * not sequence).
 */
export const MANAGED_ARTIFACT_SCOPES = ['project', 'global'] as const;
export type ManagedArtifactScope = (typeof MANAGED_ARTIFACT_SCOPES)[number];

/** True when `name` is a skill or template synthetic doc name. */
export function isManagedArtifactDocName(name: string): boolean {
  return (
    name.startsWith(MANAGED_ARTIFACT_PREFIX_SKILL) ||
    name.startsWith(MANAGED_ARTIFACT_PREFIX_TEMPLATE)
  );
}

/**
 * Scope-relative root holding every skill's source dir: `<contentDir>/.ok/skills`
 * for project skills (git-committed, shared via the project repo) and
 * `<home>/.ok/skills` for global skills (user-level). SINGLE source of truth
 * for the `.ok/skills/...` path shared by the content filter (admission), the
 * doc-name routing (app + server), and the timeline query. The prefix is baked
 * into the shadow-repo object-store key scheme, so a change here is a one-way
 * door that must stay atomic across every consumer — hence one compile-time
 * constant rather than independent copies per package.
 */
export const SKILL_CONTENT_ROOT = '.ok/skills';

/**
 * The CONTENT doc name for a PROJECT skill's `SKILL.md`
 * (`.ok/skills/<name>/SKILL`, ext-less). Project skills are real content docs
 * (skills-as-content), unlike global skills which stay
 * `__skill__/global/<name>` managed-artifact docs.
 */
export function projectSkillContentDocName(name: string): string {
  return `${SKILL_CONTENT_ROOT}/${name}/SKILL`;
}

/**
 * Bundle sub-directories a SKILL.md may reference relative to its own dir. A
 * wiki-link `[[references/x]]` / `[[scripts/y]]` inside a SKILL.md is authored
 * bundle-relative (Obsidian-style bare/relative targets), so its inbound graph
 * edge must resolve against the skill dir, not the content root.
 */
const SKILL_BUNDLE_SUBDIRS = ['references', 'scripts'] as const;

/**
 * If `sourceDocName` is a PROJECT skill's `SKILL` content doc and `target` is a
 * bundle-relative path into that skill's `references/` or `scripts/` dir, return
 * the sibling bundle file's content doc name (ext-less); else null.
 *
 * Resolves the INBOUND-link asymmetry: a markdown link `[x](references/x.md)`
 * from a SKILL.md already resolves through `resolveInternalHref` (source-dir
 * relative), but a wiki-link `[[references/x]]` is classified as a bare KB-wide
 * doc name (`references/x` at the content root) and never reaches the bundle
 * ref — so the ref shows 0 backlinks / sits orphaned in the graph. The server
 * link index and the client chip resolver share this helper so both surfaces
 * map a bundle-relative skill wiki-link to the same bundle ref doc.
 *
 * Scope is deliberately narrow: only a SKILL-doc source + a `references/` or
 * `scripts/` first segment qualifies, so KB-wide bare-name wiki-link behavior
 * (`[[notes]]` resolving against the page set) is untouched. `..` escapes and
 * targets that leave the skill dir return null.
 */
export function resolveSkillBundleWikiTarget(target: string, sourceDocName: string): string | null {
  const skillDirMatch = /^(\.ok\/skills\/[^/]+)\/SKILL$/.exec(sourceDocName);
  if (!skillDirMatch) return null;
  const skillDir = skillDirMatch[1] as string;

  const trimmed = target.trim();
  // Strip a trailing markdown extension so `[[references/x.md]]` and
  // `[[references/x]]` resolve identically (refs are ext-less content docs).
  const withoutExt = trimmed.replace(/\.mdx?$/i, '');
  const segments = withoutExt.split('/').filter((s) => s !== '' && s !== '.');
  const [first] = segments;
  if (!first || !(SKILL_BUNDLE_SUBDIRS as readonly string[]).includes(first)) return null;
  // No `..` traversal — a bundle-relative reference never escapes the skill dir.
  if (segments.includes('..')) return null;
  if (segments.length < 2) return null;
  return `${skillDir}/${segments.join('/')}`;
}

/**
 * A project skill bundle content doc, identified purely by its NAME shape — no
 * filesystem access. A skill's `SKILL` doc and its `references/<rel>` docs share
 * the same `.ok/skills/<name>/` parent; the link index uses that shared parent to
 * draw structural graph edges between them so a reference is connected regardless
 * of whether the SKILL body links to it. `scripts/**` and global skills are NOT
 * graph nodes, so they are deliberately excluded here.
 *
 *  - `kind: 'skill'`  → `.ok/skills/<name>/SKILL`         (`rel` is `null`)
 *  - `kind: 'reference'` → `.ok/skills/<name>/references/<rel>` (`rel` ext-less)
 *
 * Returns null for anything else (regular docs, scripts, global skills).
 */
export type ParsedProjectSkillBundleDoc =
  | { name: string; kind: 'skill'; rel: null }
  | { name: string; kind: 'reference'; rel: string };

const PROJECT_SKILL_BUNDLE_DOC_RE = /^\.ok\/skills\/([^/]+)\/(SKILL|references\/.+)$/;

export function parseProjectSkillBundleDoc(docName: string): ParsedProjectSkillBundleDoc | null {
  const match = PROJECT_SKILL_BUNDLE_DOC_RE.exec(docName);
  if (!match) return null;
  const name = match[1] as string;
  const tail = match[2] as string;
  if (tail === 'SKILL') return { name, kind: 'skill', rel: null };
  // `references/<rel>` — `rel` is the bundle-relative ext-less path under the
  // skill's `references/` dir; the regex `.+` already guarantees it is non-empty.
  return { name, kind: 'reference', rel: tail.slice('references/'.length) };
}

/**
 * A GLOBAL skill bundle doc, identified purely by its NAME shape. Global skills
 * live at `<home>/.ok/skills/<name>/`, OUTSIDE the project content dir, so their
 * bundle docs are NOT content docs — they keep the managed-artifact namespace:
 *
 *  - `kind: 'skill'`     → `__skill__/global/<name>`                  (`rel` is `null`)
 *  - `kind: 'reference'` → `__skill__/global/<name>/references/<rel>` (`rel` ext-less)
 *
 * The reference identity extends the SKILL doc name (`skillLiveDocName('global',
 * name)`) with the same `references/<rel>` tail the project bundle uses, so a
 * SKILL and its references share the `__skill__/global/<name>/` parent and the
 * link index can draw within-bundle structural edges from the name alone.
 *
 * `scripts/**` are not graph nodes (mirrors the project predicate), and a name
 * segment that is not exactly `global` (e.g. `project`) returns null so only the
 * global store qualifies. Returns null for anything else.
 */
export type ParsedGlobalSkillBundleDoc =
  | { name: string; kind: 'skill'; rel: null }
  | { name: string; kind: 'reference'; rel: string };

const GLOBAL_SKILL_BUNDLE_DOC_RE = /^__skill__\/global\/([^/]+)(?:\/(references\/.+))?$/;

export function parseGlobalSkillBundleDoc(docName: string): ParsedGlobalSkillBundleDoc | null {
  const match = GLOBAL_SKILL_BUNDLE_DOC_RE.exec(docName);
  if (!match) return null;
  const name = match[1] as string;
  const tail = match[2];
  if (tail === undefined) return { name, kind: 'skill', rel: null };
  // `references/<rel>` — `rel` is the bundle-relative ext-less path; the regex
  // `.+` already guarantees it is non-empty.
  return { name, kind: 'reference', rel: tail.slice('references/'.length) };
}

/**
 * The LIVE CRDT doc name to OPEN / activate / retarget for a skill of the given
 * scope — the single routing helper every skill-open call site uses, shared by
 * the app (tab open) and the server (delete / move / restore retarget). Project
 * skills are content docs (`.ok/skills/<name>/SKILL`); global skills are
 * managed-artifact docs (`__skill__/global/<name>`). Routing a project skill
 * to the bare `__skill__/project/<name>` opens a phantom empty doc and desyncs
 * delete / move, so this distinction is load-bearing.
 */
export function skillLiveDocName(scope: ManagedArtifactScope, name: string): string {
  return scope === 'project'
    ? projectSkillContentDocName(name)
    : `${MANAGED_ARTIFACT_PREFIX_SKILL}${scope}/${name}`;
}

/**
 * Parsed managed-artifact doc name. The two kinds are addressed DIFFERENTLY:
 *  - skill: `__skill__/<scope>/<name>` — `scope` ∈ {global, project}; the
 *    skill folder lives under `<scope-root>/.ok/skills/<name>/`.
 *  - template: `__template__/<folderRel>/<name>` — `folder` is the
 *    project-root-relative folder owning the template (`''` = project root,
 *    may be nested like `notes/sub`); the template lives at
 *    `<folder>/.ok/templates/<name>.md`. Templates have NO global/project
 *    scope — they are folder-local with leaf→root inheritance.
 */
export type ParsedManagedArtifactName =
  | { kind: 'skill'; scope: ManagedArtifactScope; name: string }
  | { kind: 'template'; folder: string; name: string };

/** Percent-decode each `/`-separated segment; returns `''` unchanged. */
function decodeManagedSegments(encoded: string): string {
  if (encoded === '') return '';
  try {
    return encoded
      .split('/')
      .map((s) => decodeURIComponent(s))
      .join('/');
  } catch {
    return encoded;
  }
}

/**
 * Parse `__skill__/<scope>/<name>` or `__template__/<folderRel>/<name>`. Returns
 * null when the prefix is unknown, the skill scope is invalid, or the name is
 * empty. The client decodes the same names via `docNameFromHash`
 * (`app/src/lib/doc-hash.ts`) then this parser. Segments are percent-decoded.
 */
export function parseManagedArtifactName(name: string): ParsedManagedArtifactName | null {
  if (name.startsWith(MANAGED_ARTIFACT_PREFIX_SKILL)) {
    const rest = name.slice(MANAGED_ARTIFACT_PREFIX_SKILL.length);
    const slash = rest.indexOf('/');
    if (slash < 0) return null;
    const scope = rest.slice(0, slash);
    if (scope !== 'global' && scope !== 'project') return null;
    const encoded = rest.slice(slash + 1);
    if (!encoded) return null;
    return { kind: 'skill', scope, name: decodeManagedSegments(encoded) };
  }
  if (name.startsWith(MANAGED_ARTIFACT_PREFIX_TEMPLATE)) {
    // Folder-addressed: split on the LAST slash — everything before is the
    // (possibly empty, possibly nested) folder, the last segment is the name.
    const rest = name.slice(MANAGED_ARTIFACT_PREFIX_TEMPLATE.length);
    if (!rest) return null;
    const lastSlash = rest.lastIndexOf('/');
    const encodedName = lastSlash < 0 ? rest : rest.slice(lastSlash + 1);
    if (!encodedName) return null;
    const encodedFolder = lastSlash < 0 ? '' : rest.slice(0, lastSlash);
    return {
      kind: 'template',
      folder: decodeManagedSegments(encodedFolder),
      name: decodeManagedSegments(encodedName),
    };
  }
  return null;
}

// A content link target / doc name that points at a template's file on disk
// (`<folder>/.ok/templates/<name>[.md]`); folder = everything before
// `.ok/templates/` (empty at the project root).
const TEMPLATE_FILE_TARGET_RE = /^(?:(.+)\/)?\.ok\/templates\/([^/]+?)(?:\.mdx?)?$/;

/**
 * Map a content link target / doc name that points at a template FILE on disk to
 * its managed-artifact doc name (`__template__/<folderRel>/<name>`). Returns null
 * when the target isn't a template file path. Shared by the client link resolver
 * and the server link index, so a doc→template link resolves to the same artifact
 * identity in both places (click-through + backlinks).
 *
 * Project skills are NOT rewritten here — they are real content docs
 * (`.ok/skills/<name>/SKILL`) and resolve through the normal page index. Global
 * skills live under `<home>/.ok/skills`, outside contentDir, unreachable from a
 * content link.
 */
export function managedArtifactDocNameFromContentTarget(target: string): string | null {
  const template = TEMPLATE_FILE_TARGET_RE.exec(target);
  if (template) {
    const folder = (template[1] ?? '').replace(/^\/+|\/+$/g, '');
    return `${MANAGED_ARTIFACT_PREFIX_TEMPLATE}${folder ? `${folder}/` : ''}${template[2]}`;
  }
  return null;
}
