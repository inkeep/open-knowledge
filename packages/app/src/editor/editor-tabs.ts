import {
  isManagedArtifactDocName,
  MANAGED_ARTIFACT_SCOPES,
  parseExternalSkillDocName,
  parseManagedArtifactName,
  parseProjectSkillBundleDoc,
  parseTemplateContentDocName,
  type RenamedAssetMapping,
  type SkillScope,
} from '@inkeep/open-knowledge-core';
import {
  decodeSkillPreviewSegments,
  encodeSkillPreviewSegments,
  type SkillPreviewFlavor,
  type SkillPreviewHashTarget,
} from '@/lib/doc-hash';
import { getKnownProjectSkillDirs } from '@/lib/known-skill-dirs';
import { parseProjectSkillContentDocName } from '@/lib/managed-artifact-doc-name';
import { skillDisplayName } from '@/lib/skill-scope';
import {
  type EditorWorkspaceState,
  type PersistedEditorPane,
  parsePersistedEditorWorkspace,
  persistEditorWorkspace,
} from './editor-panes';

/** Narrow a free string to a known skill scope (`project` | `global`). */
function isSkillScope(value: string): value is SkillScope {
  return (MANAGED_ARTIFACT_SCOPES as readonly string[]).includes(value);
}

export interface EditorTabSessionState {
  updatedAt: string | null;
  /** Authoritative persisted split-workspace layout. */
  panes: PersistedEditorPane[];
  focusedPaneId: string;
}

/** A fresh empty session — factory (not a shared const) so callers can't alias it. */
function emptyTabSessionState(): EditorTabSessionState {
  return sessionStateFromWorkspace(parsePersistedEditorWorkspace(null), null);
}

export interface RenamedFolderMapping {
  fromPath: string;
  toPath: string;
}

interface KnownTabTargets {
  pages: ReadonlySet<string>;
  folderPaths: ReadonlySet<string>;
  assetPaths: ReadonlySet<string>;
  filePaths?: ReadonlySet<string>;
  keepMissingDocName?: string | null;
  /**
   * Doc the location hash currently points at — kept even when absent from
   * `pages`. The page list loads empty-then-populated on cold start, so a sync
   * that fires in that window would otherwise evict the doc the user is
   * navigating to (clearing the hash → empty-state splash). Genuine removal is
   * handled by the deletion path (`onDocDeleted`), not this prune, so retaining
   * the navigated doc here can't strand a deleted one. Distinct from
   * `keepMissingDocName`, which only protects an already-resolved `missing`
   * target — the cold-start race evicts before that resolution runs.
   */
  keepHashDocName?: string | null;
  /**
   * Folders the caller is currently displaying, kept even when absent from
   * `folderPaths`. Only the server's folder listing can carry an EMPTY folder,
   * since nothing derives one from `pages`, and unlike `pages` that listing has
   * no optimistic bridge. A folder therefore stays unknown here for the whole
   * create or rename round-trip, and a sync landing inside that window would
   * otherwise prune the folder tab the user had just navigated into. Folder counterpart of
   * `keepHashDocName`. Order-independent with respect to a rename, because the
   * caller reads a target the commit re-derived from the pane's own tab id (see
   * `paneWithResolvedTarget`), so this matches whether the prune runs before or
   * after the remap.
   *
   * A SET of paths rather than one name, because the caller resolves this from
   * the panes' active targets, not from the hash: a folder reached by wiki link
   * carries no trailing slash and is indistinguishable from a doc by shape, and
   * a split workspace can display more than one folder at once.
   *
   * This DEFERS a close rather than preventing one, and only for folders on
   * screen. In-app deletion closes these tabs by id through
   * `reconcileLocalRemoval`, so that path is unaffected. An EXTERNAL delete
   * (agent, MCP, another client) has no folder equivalent of the provider pool's
   * `doc-deleted` signal, which is what lets the doc branch above lean on a
   * deletion path, so for folders this prune is the only closer and such a tab
   * survives while its folder is displayed. A folder tab holds no collaboration
   * provider, so a stale one cannot diverge a room the way a stale doc tab
   * could.
   */
  keepFolderPaths?: ReadonlySet<string>;
}

const EMPTY_FOLDER_PATHS: ReadonlySet<string> = new Set<string>();
const LOCAL_TAB_SESSION_PREFIX = 'ok-editor-tabs-v1:';
const FOLDER_TAB_PREFIX = '\u0000folder:';
const ASSET_TAB_PREFIX = '\u0000asset:';
// Skill bundle files are addressed by three coordinates (scope / name / path),
// not a single path, so they get their own tab namespace. `name` carries no
// slash (lowercase-hyphen identity), so `scope/name/<path-tail>` parses back
// unambiguously even though `path` may contain slashes.
const SKILL_FILE_TAB_PREFIX = '\u0000skill-file:';
const SKILL_PREVIEW_TAB_PREFIX = '\u0000skill-preview:';
const MARKDOWN_TAB_EXTENSION_PATTERN = /\.(md|mdx)$/i;

function stripMarkdownTabExtension(path: string): string | null {
  return MARKDOWN_TAB_EXTENSION_PATTERN.test(path)
    ? path.replace(MARKDOWN_TAB_EXTENSION_PATTERN, '')
    : null;
}

/**
 * True when another id in the session is extension-qualified under the same stem
 * as `tabId` — `foo.md` alongside `foo.mdx`.
 *
 * A doc name is its on-disk path with one markdown extension removed, so a
 * QUALIFIED doc name belongs to a file carrying a second markdown extension of
 * its own (`foo.md.md`, `foo.mdx.md`). Two of those under one stem are two
 * DISTINCT files, and stripping either would merge both into a single tab. This
 * is not the same-stem `.md` + `.mdx` case: that pair is indexed under one bare
 * stem, so only its winning half ever becomes a tab id. An extension-carrying id
 * whose only relative is the bare stem is the opposite case — one file
 * addressed twice.
 */
function sharesStemWithAnotherQualifiedTab(
  tabId: string,
  siblingTabIds: readonly string[],
): boolean {
  const stem = stripMarkdownTabExtension(tabId);
  if (stem === null) return false;
  return siblingTabIds.some(
    (other) => other !== tabId && stripMarkdownTabExtension(other) === stem,
  );
}

/**
 * Collapse a doc tab id onto the name that keys exactly ONE collaboration room.
 *
 * A doc tab's id IS its docName, so an extension-carrying id addresses the same
 * file on disk as its stripped twin while keying a second room over that file.
 * The two rooms diverge permanently and both write to it, so the loser's edits
 * are overwritten with no merge. Strips repeatedly, so `foo.md.md` lands on
 * `foo` rather than on the still-qualified `foo.md`.
 *
 * Folder, asset, and skill-viewer ids address a path rather than a room, so they
 * keep their extension; so does any doc name without a markdown extension,
 * including the synthetic system and config docs.
 */
function canonicalTabId(tabId: string, siblingTabIds: readonly string[] = []): string {
  if (parseEditorTabId(tabId).kind !== 'doc') return tabId;
  if (sharesStemWithAnotherQualifiedTab(tabId, siblingTabIds)) return tabId;
  let docName = tabId;
  let stripped = stripMarkdownTabExtension(docName);
  while (stripped !== null && stripped.length > 0) {
    docName = stripped;
    stripped = stripMarkdownTabExtension(docName);
  }
  return docName;
}

function canonicalTabIdList(value: unknown, siblingTabIds: readonly string[]): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item) =>
    typeof item === 'string' ? canonicalTabId(item, siblingTabIds) : item,
  );
}

/** Every persisted tab id across the session's panes, in pane order. */
function persistedTabIds(panes: readonly unknown[]): string[] {
  return panes.flatMap((pane) => {
    if (typeof pane !== 'object' || pane === null) return [];
    const openTabs = (pane as Record<string, unknown>).openTabs;
    if (!Array.isArray(openTabs)) return [];
    return openTabs.filter((tabId): tabId is string => typeof tabId === 'string');
  });
}

/**
 * Rewrite persisted tab identifiers to their canonical form before the pane
 * parser reads them.
 *
 * Nothing normalized these ids on the way in, so a profile that ever opened an
 * extension-carrying doc name re-mints that second room on every launch:
 * normalizing only what is written from here on would leave those profiles
 * broken indefinitely. Repair happens on the read side of BOTH stores (browser
 * local storage and the desktop bridge), which share this parse.
 *
 * Entries are mapped rather than dropped — dropping one would close a tab the
 * user left open. The pane parser's own de-duplication then folds a repaired id
 * into an already-open canonical one, so a session holding both shapes restores
 * as one tab instead of two over the same file.
 */
function repairPersistedTabIds(record: Record<string, unknown>): Record<string, unknown> {
  const repaired: Record<string, unknown> = { ...record };
  const siblingTabIds = Array.isArray(record.panes) ? persistedTabIds(record.panes) : [];
  if (Array.isArray(record.panes)) {
    repaired.panes = record.panes.map((pane) => {
      if (typeof pane !== 'object' || pane === null) return pane;
      const entry = pane as Record<string, unknown>;
      return {
        ...entry,
        openTabs: canonicalTabIdList(entry.openTabs, siblingTabIds),
        pinnedTabIds: canonicalTabIdList(entry.pinnedTabIds, siblingTabIds),
        activeTabId:
          typeof entry.activeTabId === 'string'
            ? canonicalTabId(entry.activeTabId, siblingTabIds)
            : entry.activeTabId,
      };
    });
  }
  return repaired;
}

function isValidTabId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000doc-tab:')) {
    return false;
  }
  const base = value;
  if (base.startsWith(FOLDER_TAB_PREFIX)) return base.length > FOLDER_TAB_PREFIX.length;
  if (base.startsWith(ASSET_TAB_PREFIX)) return base.length > ASSET_TAB_PREFIX.length;
  if (base.startsWith(SKILL_FILE_TAB_PREFIX)) return parseSkillFileTabBody(base) !== null;
  if (base.startsWith(SKILL_PREVIEW_TAB_PREFIX)) return parseSkillPreviewTabBody(base) !== null;
  return true;
}

/** The coordinates a skill-file tab/target round-trips. */
export interface SkillFileTabTarget {
  scope: SkillScope;
  name: string;
  path: string;
  /**
   * Which same-named bundle owns this file — two distinct-content skills can
   * share a name across host dirs, and without this their tabs collide (opening
   * one focuses the other). Omitted = the by-name default.
   */
  host?: string;
}

/** `:` can't appear in a skill name (`^[a-z0-9-]+$`), so a host suffix on the
 *  name segment can't be mistaken for part of one — which is what keeps tab ids
 *  written before the host existed parsing as host-less. */
const SKILL_FILE_TAB_HOST_SEP = ':';

export function skillFileTabId(target: SkillFileTabTarget): string {
  const named =
    target.host === undefined
      ? target.name
      : `${target.name}${SKILL_FILE_TAB_HOST_SEP}${target.host}`;
  return `${SKILL_FILE_TAB_PREFIX}${target.scope}/${named}/${target.path}`;
}

/** Parse the `<scope>/<name>[:<host>]/<path…>` body of a skill-file tab id. */
function parseSkillFileTabBody(base: string): SkillFileTabTarget | null {
  if (!base.startsWith(SKILL_FILE_TAB_PREFIX)) return null;
  const body = base.slice(SKILL_FILE_TAB_PREFIX.length);
  const segments = body.split('/');
  if (segments.length < 3) return null;
  const [scope, named, ...rest] = segments;
  const path = rest.join('/');
  // Validate scope against the known set — a tab id is persisted state that can
  // be hand-edited / stale, so an unknown scope must not silently become a
  // skill-file target with a bogus scope.
  if (!scope || !named || !path || !isSkillScope(scope)) return null;
  const sep = named.indexOf(SKILL_FILE_TAB_HOST_SEP);
  const name = sep === -1 ? named : named.slice(0, sep);
  const host = sep === -1 ? undefined : named.slice(sep + 1);
  if (!name) return null;
  return { scope, name, path, ...(host ? { host } : {}) };
}

/** Same coordinate shape as a skill-preview location hash — a tab id is just the
 *  persisted form. */

export function skillPreviewTabId(target: SkillPreviewHashTarget): string {
  return `${SKILL_PREVIEW_TAB_PREFIX}${encodeSkillPreviewSegments(target)}`;
}

/**
 * Tab ids holding the SAME local skill preview as `openedTabId` under a
 * DIFFERENT id — the twins a fresh open must close.
 *
 * A local preview's id includes its `source` path, which moves under the tab (a
 * plugin update bumps the version in the cache path; a detected skill relocates
 * when a copy is deleted) and its `level`. The same skill then lives under two
 * ids at once: identically labelled tabs, one of which every click resolves
 * away from — "multiple tabs of the same file open, only able to focus one".
 * One skill, one local preview; explore keeps `source` in its identity on
 * purpose (one name from two repos is two previews), so it is never matched.
 *
 * `subtitle` IS part of the identity: same-name copies in different harness
 * dirs surface as separate rows whose only distinguisher is the host subtitle
 * ("plannotator-review (.agents)" vs "(claude)"), and treating those as twins
 * closes a genuinely different copy. A version bump moves only `source`, never
 * the subtitle, so the dedup this exists for is unaffected.
 */
export function staleLocalSkillPreviewTwins(
  openTabs: readonly string[],
  opened: { flavor: SkillPreviewFlavor; name: string; subtitle: string; level: SkillScope },
  openedTabId: string,
): string[] {
  if (opened.flavor === 'explore') return [];
  return openTabs.filter((id) => {
    if (id === openedTabId) return false;
    const tab = parseEditorTabId(id);
    return (
      tab.kind === 'skill-preview' &&
      tab.flavor === opened.flavor &&
      tab.name === opened.name &&
      tab.subtitle === opened.subtitle &&
      tab.level === opened.level
    );
  });
}

/**
 * Find an already-open preview tab for the SAME LOCAL skill, keyed by
 * flavor + name + subtitle + level and IGNORING the volatile `source` path.
 * Subtitle stays in the key because same-name copies in different harness dirs
 * are different previews — reusing across them is a click that "does nothing". Every
 * local-path flavor moves under you: a built-in's bundle path can differ
 * between skills-list refetches, and a detected skill's path carries the
 * PLUGIN VERSION (`…/plugins/cache/<marketplace>/<plugin>/1.2.679/skills/<name>`)
 * or moves when its installed copy is deleted and it is re-detected at its
 * original location. `source` is part of the tab identity, so without this
 * reuse each such open spawns a DUPLICATE preview tab — two tabs with the same
 * label, one of which looks un-closeable because closing it leaves its
 * identical sibling on screen.
 *
 * `explore` is deliberately NOT deduped this way: there, `source` is the
 * marketplace coordinate, and two same-named skills from different repos are
 * genuinely different previews.
 *
 * Returns the tab id to reactivate, or null to open fresh.
 */
export function findLocalSkillPreviewTabId(
  openTabs: readonly string[],
  flavor: Extract<SkillPreviewFlavor, 'builtin' | 'detected' | 'foreign' | 'linked'>,
  name: string,
  subtitle: string,
  scope: SkillScope,
): string | null {
  for (const id of openTabs) {
    const tab = parseEditorTabId(id);
    if (
      tab.kind === 'skill-preview' &&
      tab.flavor === flavor &&
      tab.name === name &&
      tab.subtitle === subtitle &&
      tab.level === scope
    ) {
      return id;
    }
  }
  return null;
}

/** Parse the encoded body of a skill-preview tab id (untrusted, hand-editable). */
function parseSkillPreviewTabBody(base: string): SkillPreviewHashTarget | null {
  if (!base.startsWith(SKILL_PREVIEW_TAB_PREFIX)) return null;
  return decodeSkillPreviewSegments(base.slice(SKILL_PREVIEW_TAB_PREFIX.length));
}

export function docTabId(docName: string): string {
  return docName;
}

export function folderTabId(folderPath: string): string {
  return `${FOLDER_TAB_PREFIX}${folderPath}`;
}

export function assetTabId(assetPath: string): string {
  return `${ASSET_TAB_PREFIX}${assetPath}`;
}

/** The Skills hub is a singleton tab — one id, no per-instance coordinates. */

export function tabParts(
  docName: string,
  docExt: string,
): { baseName: string; extension: string; label: string; prefix: string } {
  // Project skills are content docs at `.ok/skills/<name>/SKILL`, but the tab
  // should read as the skill's NAME (matching global skills, whose tab shows
  // the name) — not the literal "SKILL" filename or the `.ok/skills/` path.
  const projectSkill = parseProjectSkillContentDocName(docName);
  if (projectSkill) {
    // Prefix-stripped display (`open-knowledge-pack-X` → `X`), matching the sidebar.
    const display = skillDisplayName(projectSkill);
    return { baseName: display, extension: '', label: display, prefix: '' };
  }
  // Editable-unmanaged skill: SKILL.md tab reads as the skill NAME (like managed
  // skills); a bundle file (`__extskill__/<name>/<rel>`) reads as its file
  // basename (like any other file tab) — not the synthetic prefix or skill name.
  const extSkill = parseExternalSkillDocName(docName);
  if (extSkill) {
    const display = extSkill.rel
      ? (extSkill.rel.split('/').pop() ?? extSkill.rel)
      : skillDisplayName(extSkill.name);
    return { baseName: display, extension: '', label: display, prefix: '' };
  }
  // A template is a content doc at `<folder>/.ok/templates/<name>`; the tab reads
  // as the bare template NAME (like skills), not the literal `.ok/templates/`
  // path prefix. The owning folder surfaces in the breadcrumb instead.
  const template = parseTemplateContentDocName(docName);
  if (template) {
    return { baseName: template.name, extension: '', label: template.name, prefix: '' };
  }
  const slash = docName.lastIndexOf('/');
  const baseName = slash < 0 ? docName : docName.slice(slash + 1);
  const extension =
    MARKDOWN_TAB_EXTENSION_PATTERN.test(docExt) && MARKDOWN_TAB_EXTENSION_PATTERN.test(baseName)
      ? ''
      : docExt;
  const label = `${baseName}${extension}`;
  if (slash < 0) return { baseName, extension, label, prefix: '' };
  return {
    baseName,
    extension,
    label,
    prefix: `${docName.slice(0, slash)}/`,
  };
}

export function tabIdForNavigationTarget(
  target:
    | { kind: 'doc'; docName: string }
    | { kind: 'folder-index'; docName: string }
    | { kind: 'folder'; folderPath: string }
    | { kind: 'asset'; assetPath: string }
    | { kind: 'skill-file'; scope: SkillScope; name: string; path: string; host?: string }
    | { kind: 'skills'; target: string }
    | {
        kind: 'skill-preview';
        flavor: SkillPreviewFlavor;
        source: string;
        name: string;
        subtitle: string;
        level?: SkillScope;
      }
    | { kind: 'large-file'; docName: string }
    | { kind: 'missing'; target: string },
): string | null {
  switch (target.kind) {
    case 'doc':
    case 'folder-index':
    case 'large-file':
      return docTabId(target.docName);
    case 'folder':
      return folderTabId(target.folderPath);
    case 'missing':
      return docTabId(target.target);
    case 'asset':
      return assetTabId(target.assetPath);
    case 'skill-file':
      return skillFileTabId(target);
    case 'skills':
      // The Skills destination is an ephemeral new-tab surface, not a standing
      // editor tab with a persistable id. The arm stays for exhaustiveness.
      return null;
    case 'skill-preview':
      return skillPreviewTabId(target);
  }
}

export function parseEditorTabId(tabId: string):
  | { kind: 'doc'; docName: string }
  | { kind: 'folder'; folderPath: string }
  | { kind: 'asset'; assetPath: string }
  | { kind: 'skill-file'; scope: SkillScope; name: string; path: string; host?: string }
  | {
      kind: 'skill-preview';
      flavor: SkillPreviewFlavor;
      source: string;
      name: string;
      subtitle: string;
      level?: SkillScope;
    } {
  const base = tabId;
  if (base.startsWith(FOLDER_TAB_PREFIX)) {
    return { kind: 'folder', folderPath: base.slice(FOLDER_TAB_PREFIX.length) };
  }
  if (base.startsWith(ASSET_TAB_PREFIX)) {
    return { kind: 'asset', assetPath: base.slice(ASSET_TAB_PREFIX.length) };
  }
  const skillPreview = parseSkillPreviewTabBody(base);
  if (skillPreview) {
    return { kind: 'skill-preview', ...skillPreview };
  }
  const skillFile = parseSkillFileTabBody(base);
  if (skillFile) {
    return { kind: 'skill-file', ...skillFile };
  }
  return { kind: 'doc', docName: base };
}

export function docNameForTabId(tabId: string): string | null {
  const tab = parseEditorTabId(tabId);
  return tab.kind === 'doc' ? tab.docName : null;
}

/**
 * How this mount's attempt to restore the persisted tab session ended.
 *
 * Three outcomes, not two, because "we did not apply the stored session" covers
 * two cases that need OPPOSITE persistence decisions. `unread` means the read
 * never resolved, so we can never learn what is stored. `suppressed` means the
 * read was deliberately skipped, so the stored session is intact and known
 * good. A single boolean collapses them and hands the `unread` escape hatch
 * below to a case where it destroys data.
 */
export type TabSessionRestoreOutcome = 'applied' | 'unread' | 'suppressed';

/**
 * Whether a tab session may be written back to storage.
 *
 * Not simply "did the restore succeed". A failed restore must not clobber a
 * session we could not READ, but gating on that alone meant one transient
 * failure disabled persistence for the whole session, silently dropping every
 * tab opened afterwards. Once the user actually has tabs open, that state is
 * worth more than the one we failed to read.
 *
 * A SUPPRESSED restore gets no such escape hatch. Crash recovery starts the
 * user from an empty workspace on purpose, so what they build there is never a
 * continuation of the session it declined to open. Letting the first opened tab
 * arm the count-based hatch would replace every stored tab, pin and pane with a
 * one-tab workspace, which is a larger loss than the crash this recovery
 * exists to escape. Suppression covers a single recovery mount, so the next
 * mount restores and persists normally.
 */
export function shouldPersistTabSession(
  restoreOutcome: TabSessionRestoreOutcome,
  openTabCount: number,
): boolean {
  if (restoreOutcome === 'suppressed') return false;
  return restoreOutcome === 'applied' || openTabCount > 0;
}

/**
 * True when a plain `doc` name belongs to a skill surface — a project skill's
 * SKILL.md / bundle file (under the skill content root) or a global `__skill__/`
 * managed artifact. The tab strip asks it twice per pane — once to decide
 * whether any open tab needs the skills list fetched at all, and once per tab to
 * withhold the file-target actions a skill tab must not offer — so both answers
 * come from one predicate rather than two shapes that could disagree.
 */
export function isSkillDocName(docName: string): boolean {
  return (
    parseProjectSkillBundleDoc(docName) != null ||
    parseManagedArtifactName(docName)?.kind === 'skill' ||
    parseExternalSkillDocName(docName) != null
  );
}

/**
 * A bundle laid out like a skill but reached by a path `isSkillDocName` does not
 * name. Drives the Files/Skills SURFACE decision only.
 *
 * Two halves, and both are load-bearing:
 *
 * SHAPE — a skills dir under a DOT-directory root. Every project root in
 * `EDITOR_PROJECT_SKILL_ROOT` is one (`.claude`, `.cursor`, `.codex`, `.github`,
 * `.opencode`, `.pi`), as is the `.agents` hub. The dot anchor is what keeps
 * ordinary repo content out: a repo that keeps its own markdown under
 * `packages/<x>/skills/<name>/` is authoring files, not addressing OK skills,
 * and reading it as skill work hijacked the sidebar away from Files on nearly
 * every click.
 *
 * DATA — bundle dirs `/api/skills` actually reported for this project. Covers
 * what no path shape can see:
 *   1. A skill dir that is a SYMLINK to elsewhere in the content dir (a repo
 *      keeping bundles in `plugins/<x>/skills/` and linking them into
 *      `.agents/`). Both paths index as documents and a relative link in the
 *      body resolves to the real, non-dot one; `canonicalPath` names it.
 *   2. A ledger-registered custom root, which is not required to be dotted.
 *
 * Neither half subsumes the other. `/api/skills` returns one row per content
 * identity and `path` names only the ELECTED CANONICAL dir — same-content copies
 * live in `hosts`/`copyDirs` — so a doc under a non-canonical copy is absent from
 * the data, and shape is what catches it. That covers the copies fan-out actually
 * writes, which land in editor host dirs (`.agents/skills/x/...` when `.claude`
 * won election).
 *
 * KNOWN GAP: a copy at a NON-dot CUSTOM root is named by neither half and reads
 * as Files. A custom root always loses canonical election (it is absent from
 * `SKILL_CANONICAL_PRECEDENCE`), so its dir never appears as `path`; being a copy
 * rather than a symlink, it gets no `canonicalPath` either; and being un-dotted,
 * shape misses it. It surfaces only as `customPlacements`/`hosts`, which this
 * predicate deliberately does NOT read: those are recorded against `projectDir`
 * while doc names are `contentDir`-relative, and under a configured `content.dir`
 * the two differ — reading them would trade a narrow miss for a wrong prefix.
 *
 * Stays synchronous and TOTAL: it is read during render, for tabs restored from
 * the persisted session before any fetch has landed. An empty known-dirs set
 * degrades to the shape answer; it never yields "unknown", which would let a
 * skill-bundle tab offer the file-target actions it must not have.
 *
 * Deliberately NOT folded into `isSkillDocName`: that parser also feeds the CC1
 * link index and managed-artifact resolution, where a looser shape would mint
 * skill edges for any document that happens to sit at this path. Widening only
 * the surface decision keeps the blast radius at "which sidebar is showing".
 *
 * Every file under a bundle counts, not just `SKILL` and `references/**`. A
 * skill is free to ship companion markdown at its bundle root (`tdd` on
 * skills.sh ships `tests.md` + `mocking.md` beside `SKILL.md`), and those docs
 * addressed as ordinary content dropped the sidebar to Files the moment the
 * user clicked one — right after installing, when the tree has the bundle
 * expanded and those rows are the obvious thing to click.
 */
const SKILL_BUNDLE_ROOT_PATH = /(?:^|\/)\.[A-Za-z0-9_-]+\/skills\/[^/]+\/.+$/;

export function isSkillBundleShapedPath(docName: string): boolean {
  if (SKILL_BUNDLE_ROOT_PATH.test(docName)) return true;
  const known = getKnownProjectSkillDirs();
  if (known.size === 0) return false;
  // Walk ancestors from the parent dir up. Starting at the PARENT (not
  // `docName` itself) is what keeps a bundle dir addressed as a doc —
  // `.claude/skills/tdd` — from matching itself: the dir is a skill, a document
  // AT that name is not a file inside one.
  for (let cut = docName.lastIndexOf('/'); cut > 0; cut = docName.lastIndexOf('/', cut - 1)) {
    if (known.has(docName.slice(0, cut))) return true;
  }
  return false;
}

export function normalizeOpenTabs(value: unknown, limit: number): string[] {
  if (!Array.isArray(value) || limit <= 0) return [];
  const tabs: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isValidTabId(item)) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    tabs.push(item);
    if (tabs.length >= limit) break;
  }
  return tabs;
}

export function normalizePinnedTabIds(value: unknown, openTabs: readonly string[]): string[] {
  const openTabSet = new Set(normalizeOpenTabs(openTabs, Number.MAX_SAFE_INTEGER));
  return normalizeOpenTabs(value, Number.MAX_SAFE_INTEGER).filter((tabId) => openTabSet.has(tabId));
}

function capOpenTabsPreservingPinned(
  tabs: readonly string[],
  limit: number,
  pinnedTabIds: readonly string[],
): string[] {
  if (limit <= 0) return [];
  const pinned = new Set(normalizeOpenTabs(pinnedTabIds, Number.MAX_SAFE_INTEGER));
  const normalized = normalizeOpenTabs(tabs, Number.MAX_SAFE_INTEGER);
  if (pinned.size === 0 && normalized.length <= limit) return normalized;

  const nextReversed: string[] = [];
  let unpinnedCount = 0;
  for (let index = normalized.length - 1; index >= 0; index--) {
    const tabId = normalized[index];
    if (pinned.has(tabId)) {
      nextReversed.push(tabId);
      continue;
    }
    if (unpinnedCount >= limit) continue;
    unpinnedCount++;
    nextReversed.push(tabId);
  }
  return nextReversed.reverse();
}

export function addPinnedTab(
  pinnedTabIds: readonly string[],
  tabId: string,
  openTabs: readonly string[],
): string[] {
  const normalized = normalizePinnedTabIds(pinnedTabIds, openTabs);
  if (!normalizeOpenTabs(openTabs, Number.MAX_SAFE_INTEGER).includes(tabId)) return normalized;
  if (normalized.includes(tabId)) return normalized;
  return [...normalized, tabId];
}

export function removePinnedTab(pinnedTabIds: readonly string[], tabId: string): string[] {
  return normalizeOpenTabs(pinnedTabIds, Number.MAX_SAFE_INTEGER).filter(
    (pinnedTabId) => pinnedTabId !== tabId,
  );
}

export function filterClosableTabIds(
  tabIds: readonly string[],
  pinnedTabIds: readonly string[],
): string[] {
  const pinned = new Set(normalizeOpenTabs(pinnedTabIds, Number.MAX_SAFE_INTEGER));
  return normalizeOpenTabs(tabIds, Number.MAX_SAFE_INTEGER).filter((tabId) => !pinned.has(tabId));
}

/**
 * Drag-mutable pin state. Only the *dragged* tab's pin status can flip, and
 * only when it crosses the pinned/unpinned divide. The divide sits after the
 * first `pinnedCount` positions (pinnedCount = number of currently-pinned open
 * tabs): positions `[0, pinnedCount)` are the pinned zone, the rest are the
 * unpinned region.
 *
 *   - Dragged tab lands inside the pinned zone → it is pinned.
 *   - Dragged tab lands in the unpinned region → it is unpinned.
 *   - Every *other* tab keeps its pin state regardless of where the reorder
 *     pushed it (pin is membership, not position) — so pinned and unpinned
 *     tabs still interleave freely and are identified by the pin icon, not by
 *     being front-clustered. Re-ordering two pinned tabs among themselves, or
 *     within the zone, never changes pin state.
 *
 * Returns the next pinnedTabIds. Pure — caller commits it.
 */
export function applyDragPinMutation(
  nextOpenTabs: readonly string[],
  pinnedTabIds: readonly string[],
  draggedTabId: string,
): string[] {
  const normalizedOpen = normalizeOpenTabs(nextOpenTabs, Number.MAX_SAFE_INTEGER);
  const prevPinned = normalizePinnedTabIds(pinnedTabIds, normalizedOpen);
  // Only open tabs are pinnable — new-tab placeholders / unknown ids never
  // mutate pin state.
  const draggedIdx = normalizedOpen.indexOf(draggedTabId);
  if (draggedIdx < 0) return prevPinned;
  const wasPinned = prevPinned.includes(draggedTabId);
  const shouldBePinned = draggedIdx < prevPinned.length;
  if (wasPinned === shouldBePinned) return prevPinned;
  return shouldBePinned
    ? addPinnedTab(prevPinned, draggedTabId, normalizedOpen)
    : removePinnedTab(prevPinned, draggedTabId);
}

export function removeOpenTab(tabs: readonly string[], tabId: string): string[] {
  return tabs.filter((tab) => tab !== tabId);
}

export function reconcileVisibleTabOrder(
  currentOrder: readonly string[],
  openTabs: readonly string[],
  newTabIds: readonly string[],
): string[] {
  const regularTabs = normalizeOpenTabs(openTabs, Number.MAX_SAFE_INTEGER);
  const regularSet = new Set(regularTabs);
  const newTabSet = new Set(newTabIds);
  const seen = new Set<string>();
  const next: string[] = [];

  for (const tabId of currentOrder) {
    if (seen.has(tabId)) continue;
    if (!regularSet.has(tabId) && !newTabSet.has(tabId)) continue;
    seen.add(tabId);
    next.push(tabId);
  }

  for (const tabId of [...regularTabs, ...newTabIds]) {
    if (seen.has(tabId)) continue;
    seen.add(tabId);
    next.push(tabId);
  }

  return next;
}

export function filterOpenTabsForKnownTargets(
  tabs: readonly string[],
  {
    pages,
    folderPaths,
    assetPaths,
    filePaths,
    keepMissingDocName = null,
    keepHashDocName = null,
    keepFolderPaths = EMPTY_FOLDER_PATHS,
  }: KnownTabTargets,
): string[] {
  return normalizeOpenTabs(tabs, Number.MAX_SAFE_INTEGER).filter((tabId) => {
    const tab = parseEditorTabId(tabId);
    if (tab.kind === 'folder') {
      return folderPaths.has(tab.folderPath) || keepFolderPaths.has(tab.folderPath);
    }
    if (tab.kind === 'asset') {
      return assetPaths.has(tab.assetPath) || filePaths?.has(tab.assetPath) === true;
    }
    // Skill bundle files are addressed outside the content tree (scope/name/
    // path), so they never appear in `pages`/`assetPaths` — keep their tabs so
    // a page-list sync doesn't prune the open viewer.
    if (tab.kind === 'skill-file') return true;
    // A pre-install skill preview is a synthetic viewer tab keyed by import
    // coordinates (not a page) — keep it like skill-file so a page-list sync
    // doesn't prune the open preview mid-session.
    if (tab.kind === 'skill-preview') return true;
    // The SKILL doc itself is owned by the skills reconciler
    // (`useReconcileSkillTabs`), which decides against the SKILLS list and holds
    // off while a write is in flight. The page list is the wrong authority for
    // it: a scope move deletes the source bundle BEFORE its response lands, so
    // the doc stops being a page mid-move and pruning it closes the very tab the
    // move is about to repoint — the retarget then matches nothing and the skill
    // cannot be opened again until a reload.
    //
    // Scoped as narrowly as that reason allows, and no wider:
    //   - the SKILL doc only (`rel === null`). A `references/*` tab keeps riding
    //     the page list, because an external delete (agent, MCP, another client)
    //     has no other closer — the reconciler keeps any tab whose SKILL still
    //     exists, so exempting them would leave a live provider on a deleted
    //     file, and typing in it would rematerialise the file on disk.
    //   - names the reconciler can actually PARSE. Exempting a shape it cannot
    //     read (a canonical `plugins/x/skills/foo/SKILL`, or an ordinary note at
    //     `docs/skills/react/SKILL.md`) would leave a tab nothing can ever close.
    //     Those names are real pages anyway, so the prune leaves them be.
    //   - the core parser directly, NOT the reconciler's `parseSkillTabDocName`
    //     wrapper: that lives in a hook which imports THIS module, and a value
    //     cycle here is what produced the CI "export not found" flake before.
    //     Global skills are managed-artifact docs and are already kept below.
    if (tab.kind === 'doc' && parseProjectSkillBundleDoc(tab.docName)?.kind === 'skill') {
      return true;
    }
    const markdownStem = stripMarkdownTabExtension(tab.docName);
    return (
      pages.has(tab.docName) ||
      (markdownStem !== null && pages.has(markdownStem)) ||
      // Managed-artifact docs (global skills) are tree-excluded by design and
      // never appear in `pages` — keep their tabs regardless. A template content
      // doc DOES land in `pages`, but only after the async `files` refetch: keep
      // it by content shape too, so a page-list sync in the index-lag window
      // can't prune a template tab the way the managed disjunct used to prevent.
      isManagedArtifactDocName(tab.docName) ||
      parseTemplateContentDocName(tab.docName) !== null ||
      tab.docName === keepMissingDocName ||
      tab.docName === keepHashDocName
    );
  });
}

export function remapOpenTabs(
  tabs: readonly string[],
  mappings: readonly { fromDocName: string; toDocName: string }[],
  limit: number,
  folderMappings: readonly RenamedFolderMapping[] = [],
  pinnedTabIds: readonly string[] = [],
  assetMappings: readonly RenamedAssetMapping[] = [],
): string[] {
  if (mappings.length === 0 && folderMappings.length === 0 && assetMappings.length === 0) {
    return normalizeOpenTabs(tabs, limit);
  }
  const bySource = new Map(mappings.map((entry) => [entry.fromDocName, entry.toDocName]));
  const docToAssetBySource = new Map(
    assetMappings.flatMap((entry) => {
      const sourceDocName = stripMarkdownTabExtension(entry.fromPath);
      return sourceDocName ? [[sourceDocName, entry.toPath] as const] : [];
    }),
  );
  const assetToDocBySource = new Map(
    assetMappings.flatMap((entry) => {
      const targetDocName = stripMarkdownTabExtension(entry.toPath);
      return targetDocName ? [[entry.fromPath, targetDocName] as const] : [];
    }),
  );
  const remapAssetPath = (assetPath: string) =>
    remapPathForAssetRenames(remapPathForFolderRenames(assetPath, folderMappings), assetMappings);
  const remapDocTabBase = (docName: string, fallbackTabId: string): string => {
    const renamedDocName = bySource.get(docName);
    if (renamedDocName) return renamedDocName;
    const assetPath = docToAssetBySource.get(docName);
    return assetPath ? assetTabId(assetPath) : fallbackTabId;
  };
  const remapAssetTabBase = (assetPath: string): string => {
    const docName = assetToDocBySource.get(assetPath);
    return docName ? docTabId(docName) : assetTabId(remapAssetPath(assetPath));
  };
  const next: string[] = [];
  const seen = new Set<string>();
  for (const tab of tabs) {
    if (!isValidTabId(tab)) continue;
    const parsed = parseEditorTabId(tab);
    // Skill-file tabs aren't renameable doc/folder/asset paths — pass through.
    const mapped =
      parsed.kind === 'doc'
        ? remapDocTabBase(parsed.docName, tab)
        : parsed.kind === 'folder'
          ? folderTabId(remapPathForFolderRenames(parsed.folderPath, folderMappings))
          : parsed.kind === 'asset'
            ? remapAssetTabBase(parsed.assetPath)
            : tab;
    if (seen.has(mapped)) continue;
    seen.add(mapped);
    next.push(mapped);
    if (pinnedTabIds.length === 0 && next.length >= limit) break;
  }
  if (pinnedTabIds.length === 0) return next;
  const remappedPinnedTabIds = pinnedTabIds.flatMap((tabId) => {
    if (!isValidTabId(tabId)) return [];
    const parsed = parseEditorTabId(tabId);
    const mapped =
      parsed.kind === 'doc'
        ? remapDocTabBase(parsed.docName, tabId)
        : parsed.kind === 'folder'
          ? folderTabId(remapPathForFolderRenames(parsed.folderPath, folderMappings))
          : parsed.kind === 'asset'
            ? remapAssetTabBase(parsed.assetPath)
            : tabId;
    return [mapped];
  });
  return capOpenTabsPreservingPinned(next, limit, remappedPinnedTabIds);
}

// Pre-seed the visible tab order with the rename-remapped equivalents so a
// subsequent `reconcileVisibleTabOrder` does not drop the stale (pre-rename)
// tabIds at the membership check and re-append the new tabIds at the end,
// shifting the renamed tab's slot. Both rename-adjacent commit
// paths in DocumentContext's client-removal reconciler — server-driven and
// local-response rename flows — MUST seed the ref through this
// helper so the invariant is structural rather than caller-enforced.
export function remapVisibleTabsForRename(
  currentOrder: readonly string[],
  renamed: readonly { fromDocName: string; toDocName: string }[],
  renamedFolders: readonly RenamedFolderMapping[] = [],
  renamedAssets: readonly RenamedAssetMapping[] = [],
): string[] {
  return remapOpenTabs(
    currentOrder,
    renamed,
    Number.MAX_SAFE_INTEGER,
    renamedFolders,
    [],
    renamedAssets,
  );
}

export function remapPathForFolderRenames(
  path: string,
  folderMappings: readonly RenamedFolderMapping[],
): string {
  for (const { fromPath, toPath } of folderMappings) {
    if (path === fromPath) return toPath;
    if (path.startsWith(`${fromPath}/`)) return `${toPath}${path.slice(fromPath.length)}`;
  }
  return path;
}

function remapPathForAssetRenames(
  path: string,
  assetMappings: readonly RenamedAssetMapping[],
): string {
  for (const { fromPath, toPath } of assetMappings) {
    if (path === fromPath) return toPath;
  }
  return path;
}

export function nextActiveTabAfterClose(
  tabs: readonly string[],
  activeTabId: string | null,
  closingTabId: string,
): string | null {
  if (activeTabId !== closingTabId) return activeTabId;
  const index = tabs.indexOf(closingTabId);
  if (index < 0) return tabs[0] ?? null;
  return tabs[index + 1] ?? tabs[index - 1] ?? null;
}

export function nextActiveTabAfterCloseMany(
  tabs: readonly string[],
  activeTabId: string | null,
  closingTabIds: Iterable<string>,
): string | null {
  if (!activeTabId) return null;
  const closing = new Set(closingTabIds);
  if (!closing.has(activeTabId)) return activeTabId;

  const index = tabs.indexOf(activeTabId);
  if (index < 0) return tabs.find((tab) => !closing.has(tab)) ?? null;
  for (let i = index + 1; i < tabs.length; i++) {
    if (!closing.has(tabs[i])) return tabs[i];
  }
  for (let i = index - 1; i >= 0; i--) {
    if (!closing.has(tabs[i])) return tabs[i];
  }
  return null;
}

export function parseEditorTabSessionState(value: unknown): EditorTabSessionState {
  if (typeof value !== 'object' || value === null) {
    return emptyTabSessionState();
  }
  const record = repairPersistedTabIds(value as Record<string, unknown>);
  if (!Array.isArray(record.panes)) return emptyTabSessionState();
  const workspace = parsePersistedEditorWorkspace(record);
  return sessionStateFromWorkspace(
    workspace,
    typeof record.updatedAt === 'string' ? record.updatedAt : null,
  );
}

function sessionStateFromWorkspace(
  workspace: ReturnType<typeof parsePersistedEditorWorkspace>,
  updatedAt: string | null,
): EditorTabSessionState {
  return {
    updatedAt,
    panes: workspace.panes,
    focusedPaneId: workspace.focusedPaneId,
  };
}

export function createEditorTabSessionState(
  workspace: EditorWorkspaceState,
  now: () => Date = () => new Date(),
): EditorTabSessionState {
  return sessionStateFromWorkspace(persistEditorWorkspace(workspace), now().toISOString());
}

export function localTabSessionStorageKey(projectKey: string): string {
  return `${LOCAL_TAB_SESSION_PREFIX}${projectKey}`;
}

/**
 * The localStorage tab-session key for a desktop window mode, or null when that
 * mode must not use localStorage at all.
 *
 * Two modes opt out, for different reasons:
 *   - `editor` persists through the desktop bridge instead, keyed per project.
 *   - `note` persists nothing. A popped-out window shows a single document, so
 *     there is no tab session worth saving, and every desktop window shares one
 *     `file://` origin — a note window writing this key would clobber the main
 *     editor window's tabs.
 *
 * Every other caller (the browser host, where the origin really is per-project)
 * gets the origin-derived key.
 */
export function localTabSessionKeyForMode(mode: string | undefined, origin: string): string | null {
  if (mode === 'editor' || mode === 'note') return null;
  return localTabSessionStorageKey(origin);
}

export function readLocalTabSessionState(
  storage: Pick<Storage, 'getItem'> | null,
  key: string,
): EditorTabSessionState {
  if (!storage) {
    return emptyTabSessionState();
  }
  try {
    const raw = storage.getItem(key);
    if (!raw) {
      return emptyTabSessionState();
    }
    return parseEditorTabSessionState(JSON.parse(raw));
  } catch (err) {
    console.warn('[editor-tabs] failed to read local tab session:', err);
    return emptyTabSessionState();
  }
}

export function writeLocalTabSessionState(
  storage: Pick<Storage, 'setItem'> | null,
  key: string,
  state: EditorTabSessionState,
): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(parseEditorTabSessionState(state)));
  } catch (err) {
    console.warn('[editor-tabs] failed to write local tab session:', err);
    // Private browsing and quota failures should not affect editing.
  }
}
