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
 * Managed-artifact synthetic doc-name namespaces.
 *
 * Unlike config docs (a bounded frozen set), managed-artifact names are OPEN —
 * one synthetic doc per skill — so membership is PREFIX-based, not set-
 * membership. The grammar is identical to the client URL fragment in
 * `app/src/lib/doc-hash.ts` (`__skill__/<scope>/<name>`) so a deep link and the
 * server doc name are the same string.
 *
 * Live managed-artifact docs (global + external skills) are a THIRD doc class
 * distinct from system/config docs: they are excluded from the document tree /
 * search / create-page (like system+config docs) BUT the observer bridge runs
 * for them (unlike config docs, which are Y.Text-only) so they get full
 * WYSIWYG+source editing. See `server/src/managed-artifact-persistence.ts`.
 *
 * `MANAGED_ARTIFACT_PREFIX_TEMPLATE` is a reserved-name TOMBSTONE, not a live
 * namespace: templates are ordinary content docs at `<folder>/.ok/templates/
 * <name>` now. The prefix is still matched by the classifiers below so a stale
 * `__template__/…` name keeps the reserved-name gates (tree exclusion, create-
 * page refusal, persistence quarantine), but `parseManagedArtifactName`
 * deliberately does NOT resolve it — `parseLegacyTemplateDocName` decodes it
 * only for the navigation redirect to the content doc.
 */
export const MANAGED_ARTIFACT_PREFIX_SKILL = '__skill__/';
export const MANAGED_ARTIFACT_PREFIX_TEMPLATE = '__template__/';

/**
 * Prefix for an EDITABLE-UNMANAGED skill doc (`__extskill__/<name>` +
 * `__extskill__/<name>/<rel>` for a bundle file). A detected skill in another
 * editor (`~/.claude/skills/<name>`, …) lives OUTSIDE the project's contentDir;
 * this synthetic doc lets it open as an editable managed-artifact-style buffer
 * that continuously autosaves back to the real harness file — with none of the
 * managed benefits (history/Revert/install/scope-move). Unlike `__skill__/`,
 * this prefix carries NO scope: the real on-disk dir is held in the server's
 * external-skill registry, keyed by name.
 */
export const MANAGED_ARTIFACT_PREFIX_EXTSKILL = '__extskill__/';

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

/** True when `name` is a skill, editable-unmanaged-skill, or stale template
 *  synthetic doc name. Skills (`__skill__/`, `__extskill__/`) are live managed-
 *  artifact-CLASS docs: editable content docs hidden from the Files tree, with
 *  custom persistence (the observer bridge runs so WYSIWYG works). Only
 *  `__extskill__/` writes OUTSIDE the project boundary. `__template__/` is a
 *  reserved-name TOMBSTONE — still matched here so the reserved-name gates hold
 *  (tree exclusion, create-page refusal, persistence quarantine), but it no
 *  longer resolves (`parseManagedArtifactName` returns null); templates are
 *  ordinary content docs. */
export function isManagedArtifactDocName(name: string): boolean {
  return (
    name.startsWith(MANAGED_ARTIFACT_PREFIX_SKILL) ||
    name.startsWith(MANAGED_ARTIFACT_PREFIX_TEMPLATE) ||
    name.startsWith(MANAGED_ARTIFACT_PREFIX_EXTSKILL)
  );
}

/** The synthetic editable doc name for an unmanaged skill's `SKILL.md`
 *  (`__extskill__/<name>`). The single builder shared by the client open path
 *  and the server endpoint response so both address the same key. */
export function externalSkillLiveDocName(name: string): string {
  return `${MANAGED_ARTIFACT_PREFIX_EXTSKILL}${name}`;
}

/** The synthetic editable doc name for an unmanaged skill's BUNDLE file
 *  (`__extskill__/<name>/<relNoExt>`) — the per-file analogue of
 *  {@link externalSkillLiveDocName} and the sibling of {@link skillFileLiveDocName}.
 *  `rel` is a `.md`/`.mdx` reference path; the extension is stripped (the server
 *  binds the ext-less name to the real file on disk, `.md` preferred). */
export function externalSkillFileLiveDocName(name: string, rel: string): string {
  const relNoExt = stripMdExt(rel);
  return `${MANAGED_ARTIFACT_PREFIX_EXTSKILL}${name}/${relNoExt}`;
}

/** True when `name` is an editable-unmanaged-skill doc (`__extskill__/…`). The
 *  single reduced-mode signal: a doc for which the managed-only affordances
 *  (history/Revert/install/scope-move/Modified-Update) are hidden. */
export function isExternalSkillDocName(name: string): boolean {
  return name.startsWith(MANAGED_ARTIFACT_PREFIX_EXTSKILL);
}

/**
 * Parse an `__extskill__/<name>` / `__extskill__/<name>/<rel>` doc name into its
 * skill name + optional bundle-relative path (`references/x`, ext-less), or null
 * when it isn't one. Deliberately NOT folded into `parseManagedArtifactName`:
 * that returns a scope-typed shape (`global | project`), and an editable-
 * unmanaged skill has NO scope — its real dir lives in the server's external-
 * skill registry. The name grammar is the shared skill slug (`[a-z0-9-]+`); the
 * security-critical containment gate is `externalSkillAbsPath` (server). */
export function parseExternalSkillDocName(
  name: string,
): { name: string; rel: string | null } | null {
  if (!name.startsWith(MANAGED_ARTIFACT_PREFIX_EXTSKILL)) return null;
  const rest = name.slice(MANAGED_ARTIFACT_PREFIX_EXTSKILL.length);
  const slash = rest.indexOf('/');
  const skillName = slash < 0 ? rest : rest.slice(0, slash);
  const rel = slash < 0 ? null : rest.slice(slash + 1);
  // cc1 imports nothing (lowest layer), so the slug grammar is inlined rather
  // than importing SKILL_NAME_REGEX. `externalSkillAbsPath` re-checks it.
  if (!/^[a-z0-9-]+$/.test(skillName)) return null;
  return { name: skillName, rel: rel && rel.length > 0 ? rel : null };
}

/**
 * The RETIRED skill store's path (`<contentDir>/.ok/skills`, `<home>/.ok/skills`).
 *
 * Skills live IN PLACE now — the source folder IS the skill, at an editor dir,
 * the `.agents/skills` hub, or a custom root. This is NOT where skills live and
 * must never be a default for a fresh write. It survives for three reasons, all
 * legacy-shaped:
 *
 *  1. Residents that have not drained. The boot migration moves them out, but a
 *     name that collides at its target never moves.
 *  2. Restoring a version whose commit predates the migration — the bundle sat
 *     here in that commit's tree.
 *  3. The git carve-out: this is the one skill root inside `.ok/`, which OK
 *     hides from git wholesale in local-only mode (see `content-filter.ts`).
 *
 * `.ok/skills` is otherwise an ORDINARY custom root — you may place a skill
 * there and it is not relocated, ranked, or marked differently from
 * `.team/skills`. If you are reaching for this constant to answer "where does a
 * skill live", you want the entry's real `path` instead.
 *
 * The prefix is baked into the shadow-repo object-store key scheme, so a change
 * here is a one-way door that must stay atomic across every consumer.
 */
/**
 * Drop a trailing `.md` / `.mdx`. Content docs are addressed extension-less, so
 * this conversion happens at every boundary that turns a real path into a doc
 * name — one spelling keeps the `.mdx` grammar in one place.
 */
export function stripMdExt(path: string): string {
  return path.replace(/\.mdx?$/i, '');
}

export const LEGACY_SKILL_STORE_ROOT = '.ok/skills';

/**
 * The CONTENT doc name for a PROJECT skill's `SKILL.md`
 * (`.ok/skills/<name>/SKILL`, ext-less). Project skills are real content docs
 * (skills-as-content), unlike global skills which stay
 * `__skill__/global/<name>` managed-artifact docs.
 */
export function projectSkillContentDocName(name: string): string {
  return `${LEGACY_SKILL_STORE_ROOT}/${name}/SKILL`;
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
/**
 * A `/<skill-name>` reference from inside a skill bundle → that sibling skill's
 * doc.
 *
 * The leading slash is the agent-facing convention for naming a skill (the way
 * a slash command names one), not a filesystem path. Skill bodies routinely
 * cross-reference each other that way — "consumer skills (`/graphics`,
 * `/motion-video`) load this" — and read as a path it points at a root-level
 * doc that does not exist, so following one offered to CREATE a page instead of
 * opening the skill.
 *
 * Resolves against the SOURCE skill's own root, so it finds siblings in
 * whichever dir the bundle lives in. A single segment only: `/a/b` is a path,
 * not a skill name.
 */
export function resolveSkillSlashTarget(target: string, sourceDocName: string): string | null {
  const trimmed = target.trim();
  if (!trimmed.startsWith('/')) return null;
  const name = trimmed.slice(1);
  if (name === '' || name.includes('/')) return null;

  const projectRoot = /^(\.[A-Za-z0-9_-]+\/skills)\/[^/]+\/(?:SKILL|references\/.+)$/.exec(
    sourceDocName,
  );
  if (projectRoot) return `${projectRoot[1] as string}/${name}/SKILL`;

  const globalSkill = /^__skill__\/(global)\/[^/]+(?:\/references\/.+)?$/.exec(sourceDocName);
  if (globalSkill) return skillLiveDocName('global', name);

  return null;
}

export function resolveSkillBundleWikiTarget(target: string, sourceDocName: string): string | null {
  // The source may be ANY doc of a bundle — the SKILL doc or a reference doc —
  // under any bundle scheme:
  //  - project skill roots (`.ok/skills` store or in-place `.<editor>/skills/…`;
  //    one shape-regex, no editor list to keep in lock-step),
  //  - global managed artifacts (`__skill__/global/<name>[/references/…]`),
  //  - editable-unmanaged externals (`__extskill__/<name>[/<rel>]`).
  // Bundle paths are authored bundle-ROOT-relative by convention regardless of
  // which bundle doc mentions them, so every source resolves against its own
  // bundle root. Only admitted docs reach the index, so the broad shape match
  // draws no spurious edges.
  const skillDirMatch =
    /^(\.[A-Za-z0-9_-]+\/skills\/[^/]+)\/(?:SKILL|references\/.+)$/.exec(sourceDocName) ??
    /^(__skill__\/global\/[^/]+)(?:\/references\/.+)?$/.exec(sourceDocName) ??
    /^(__extskill__\/[^/]+)(?:\/.+)?$/.exec(sourceDocName);
  if (!skillDirMatch) return null;
  const skillDir = skillDirMatch[1] as string;

  const trimmed = target.trim();
  // Strip a trailing markdown extension so `[[references/x.md]]` and
  // `[[references/x]]` resolve identically (refs are ext-less content docs).
  const withoutExt = stripMdExt(trimmed);
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

// Any skill root: the `.ok/skills` store OR an in-place editor dir
// (`.claude/skills`, `.codex/skills`, `.github/skills`, …). Shape-matched (every
// root is `.<editor>/skills/`) so no editor list to keep in lock-step; only
// admitted skills reach the index, so a broad match draws no spurious edges.
const PROJECT_SKILL_BUNDLE_DOC_RE = /^\.[A-Za-z0-9_-]+\/skills\/([^/]+)\/(SKILL|references\/.+)$/;

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
  | { name: string; kind: 'skill'; rel: null; host: string | null }
  | { name: string; kind: 'reference'; rel: string; host: string | null };

const GLOBAL_SKILL_BUNDLE_DOC_RE = /^__skill__\/global\/([^/]+)(?:\/(references\/.+))?$/;

export function parseGlobalSkillBundleDoc(docName: string): ParsedGlobalSkillBundleDoc | null {
  const match = GLOBAL_SKILL_BUNDLE_DOC_RE.exec(docName);
  if (!match) return null;
  // A `@<host>` qualifier (non-default same-named bundle) splits off so every
  // consumer matches the SKILL's real name; `host` says which bundle it is.
  const { name, host } = splitSkillHostQualifier(match[1] as string);
  const tail = match[2];
  if (tail === undefined) return { name, kind: 'skill', rel: null, host };
  // `references/<rel>` — `rel` is the bundle-relative ext-less path; the regex
  // `.+` already guarantees it is non-empty.
  return { name, kind: 'reference', rel: tail.slice('references/'.length), host };
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
export function skillLiveDocName(scope: ManagedArtifactScope, name: string, host?: string): string {
  return scope === 'project'
    ? projectSkillContentDocName(name)
    : `${MANAGED_ARTIFACT_PREFIX_SKILL}${scope}/${name}${host ? `@${host}` : ''}`;
}

/**
 * Optional HOST qualifier on a GLOBAL managed skill doc name:
 * `__skill__/global/<name>@<host>` addresses the same-named bundle living in
 * that host's user root (`~/.cursor/skills/<name>`, …) rather than the by-name
 * default. Without it, two distinct-content global bundles sharing a name
 * collapsed onto ONE doc: both sidebar rows opened one tab, the watcher fed
 * both files into it, and persistence wrote back only to the precedence
 * winner — edits made on the other row silently landed in the wrong bundle.
 * The by-name default bundle keeps its unqualified name, so single-bundle
 * skills (the overwhelming case) keep a stable identity. `@` cannot appear in
 * a skill name (`SKILL_NAME_REGEX` is `[a-z0-9-]+`), so the split is
 * unambiguous.
 */
export function splitSkillHostQualifier(segment: string): { name: string; host: string | null } {
  const at = segment.indexOf('@');
  if (at < 0) return { name: segment, host: null };
  const host = segment.slice(at + 1);
  return { name: segment.slice(0, at), host: host === '' ? null : host };
}

/**
 * The LIVE CRDT doc name for a skill's bundle FILE — the per-file analogue of
 * {@link skillLiveDocName}, for editing a `.md`/`.mdx` reference in place. `rel`
 * is the bundle-relative path (e.g. `references/patterns.md`); the returned name
 * is ext-less (matching the SKILL-doc convention). Project skill files are
 * content docs (`.ok/skills/<name>/<rel>`, resolved by the page index); global
 * skill files are managed-artifact docs (`__skill__/global/<name>/<rel>`,
 * resolved by `managedArtifactAbsPath`). Both open editable through the same
 * routing the SKILL.md uses.
 */
export function skillFileLiveDocName(
  scope: ManagedArtifactScope,
  name: string,
  rel: string,
  host?: string,
): string {
  const relNoExt = stripMdExt(rel);
  return scope === 'project'
    ? `${LEGACY_SKILL_STORE_ROOT}/${name}/${relNoExt}`
    : `${MANAGED_ARTIFACT_PREFIX_SKILL}${scope}/${name}${host ? `@${host}` : ''}/${relNoExt}`;
}

/**
 * Parsed managed-artifact doc name. Only skills carry a synthetic managed name:
 * `__skill__/<scope>/<name>` — `scope` ∈ {global, project}; the skill folder
 * lives under `<scope-root>/.ok/skills/<name>/`. `rel` is a bundle-relative file
 * path into the skill dir, or `null` for the bare SKILL.md doc.
 *
 * Templates are ordinary content docs addressed by their content-relative path
 * (`parseTemplateContentDocName`); a stale `__template__/…` name is a reserved
 * tombstone this parser deliberately does NOT resolve, so it can never reach the
 * content branch. `parseLegacyTemplateDocName` decodes such a name for the
 * navigation redirect that forwards an old deep link to its content doc.
 */
export type ParsedManagedArtifactName = {
  kind: 'skill';
  scope: ManagedArtifactScope;
  name: string;
  /** Host qualifier for a non-default same-named GLOBAL bundle (see
   *  {@link splitSkillHostQualifier}); null for the ordinary unqualified doc. */
  host: string | null;
  rel: string | null;
};

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
 * Parse `__skill__/<scope>/<name>`. Returns null when the prefix is not a skill
 * name (including a `__template__/…` tombstone), the skill scope is invalid, or
 * the name is empty. The client decodes the same names via `docNameFromHash`
 * (`app/src/lib/doc-hash.ts`) then this parser. Segments are percent-decoded.
 *
 * `__template__/…` intentionally returns null: templates are content docs, so a
 * stale synthetic name must NOT resolve to a live artifact here — that is what
 * keeps it a tombstone. The navigation redirect reads it via
 * `parseLegacyTemplateDocName` instead.
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
    // `<name>` is a single slug segment; anything after it is a bundle-relative
    // FILE path (`rel`) into the skill dir — `null` for the bare SKILL.md doc
    // (`__skill__/<scope>/<name>`), so existing callers are unchanged.
    const decoded = decodeManagedSegments(encoded);
    const nameEnd = decoded.indexOf('/');
    const segment = nameEnd < 0 ? decoded : decoded.slice(0, nameEnd);
    if (!segment) return null;
    const rel = nameEnd < 0 ? null : decoded.slice(nameEnd + 1);
    const { name: skillName, host } = splitSkillHostQualifier(segment);
    if (!skillName) return null;
    return { kind: 'skill', scope, name: skillName, host, rel };
  }
  return null;
}

// A content link target / doc name that points at a template's file on disk
// (`<folder>/.ok/templates/<name>[.md]`); folder = everything before
// `.ok/templates/` (empty at the project root). Consumed by the content-name
// shape parser below. `.md` only — a template IS a `.md` leaf (the content
// filter admits nothing else under `.ok/templates/`), so a `.mdx`-suffixed
// target is not a template reference and must fall through.
const TEMPLATE_FILE_TARGET_RE = /^(?:(.+)\/)?\.ok\/templates\/([^/]+?)(?:\.md)?$/;

/**
 * A template's identity — its owning folder (project-root-relative, `''` at the
 * project root, may be nested like `notes/sub`) and bare name. The content-name
 * shape parser and the legacy synthetic-name parser both resolve to this.
 */
export type ParsedTemplateName = { folder: string; name: string };

/**
 * The CONTENT doc name for a folder-local template
 * (`<folderRel>/.ok/templates/<name>`, ext-less). `folderRel` is the
 * project-root-relative owning folder (`''` at the project root, may be nested
 * like `notes/sub`); `name` is the bare template name (the on-disk file is
 * `<name>.md`, but content docs are addressed ext-less).
 *
 * Names are RAW — no percent-encoding. A folder containing spaces round-trips
 * the generic doc-name hash layer like any other spaced content doc, so the
 * percent-encoding the synthetic `__template__/…` namespace used is unnecessary
 * here.
 */
export function templateContentDocName(folderRel: string, name: string): string {
  const folder = folderRel.replace(/^\/+|\/+$/g, '');
  return folder ? `${folder}/.ok/templates/${name}` : `.ok/templates/${name}`;
}

/**
 * Parse a CONTENT doc name that addresses a template leaf
 * (`<folder>/.ok/templates/<name>`) into its owning folder + bare name, or null
 * when the name is not a single-leaf template path. A path with a subdirectory
 * under `.ok/templates/` (e.g. `<folder>/.ok/templates/sub/x`) returns null —
 * templates are single leaves, never nested. The inverse of
 * {@link templateContentDocName}.
 *
 * Shape-only: the leaf is NOT checked against the template-name grammar, so a
 * name that would fail validation still parses. Name validation lives at the
 * HTTP write layer, not in the doc-name grammar.
 */
export function parseTemplateContentDocName(docName: string): ParsedTemplateName | null {
  const match = TEMPLATE_FILE_TARGET_RE.exec(docName);
  if (!match) return null;
  return { folder: (match[1] ?? '').replace(/^\/+|\/+$/g, ''), name: match[2] as string };
}

/**
 * Parse a stale SYNTHETIC template doc name (`__template__/<folderRel>/<name>`)
 * into its folder + name, percent-DECODING each segment, or null when the name
 * is not a synthetic template name (e.g. an ordinary content doc name).
 *
 * The synthetic namespace percent-encoded its segments, so decoding is required
 * to recover the RAW folder/name a content doc uses — a raw-only reader would
 * forward an encoded stale name to a literally-encoded content doc. For the
 * navigation redirect that forwards an old `__template__/…` deep link to its
 * content doc; new code addresses templates by their content name.
 */
export function parseLegacyTemplateDocName(name: string): ParsedTemplateName | null {
  if (!name.startsWith(MANAGED_ARTIFACT_PREFIX_TEMPLATE)) return null;
  const rest = name.slice(MANAGED_ARTIFACT_PREFIX_TEMPLATE.length);
  if (!rest) return null;
  const lastSlash = rest.lastIndexOf('/');
  const encodedName = lastSlash < 0 ? rest : rest.slice(lastSlash + 1);
  if (!encodedName) return null;
  const encodedFolder = lastSlash < 0 ? '' : rest.slice(0, lastSlash);
  return {
    folder: decodeManagedSegments(encodedFolder),
    name: decodeManagedSegments(encodedName),
  };
}
