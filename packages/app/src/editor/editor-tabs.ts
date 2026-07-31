import {
  isManagedArtifactDocName,
  MANAGED_ARTIFACT_SCOPES,
  parseExternalSkillDocName,
  parseManagedArtifactName,
  parseProjectSkillBundleDoc,
  type RenamedAssetMapping,
  type SkillScope,
} from '@inkeep/open-knowledge-core';
import {
  decodeSkillPreviewSegments,
  encodeSkillPreviewSegments,
  type SkillPreviewFlavor,
  type SkillPreviewHashTarget,
} from '@/lib/doc-hash';
import { parseProjectSkillContentDocName } from '@/lib/managed-artifact-doc-name';
import { skillDisplayName } from '@/lib/skill-scope';

/** Narrow a free string to a known skill scope (`project` | `global`). */
function isSkillScope(value: string): value is SkillScope {
  return (MANAGED_ARTIFACT_SCOPES as readonly string[]).includes(value);
}

interface EditorTabSessionState {
  openTabs: string[];
  pinnedTabIds: string[];
  activeDocName: string | null;
  activeTabId: string | null;
  /**
   * Last-active tab per surface (Files vs Skills), so a reload can restore the
   * tab you had open in EACH surface — not just the active one. Each entry is an
   * open-tab id of its own surface, or null.
   */
  activeTabByMode: { files: string | null; skills: string | null };
  updatedAt: string | null;
}

/** An open-tab id valid for `surface`, else null (guards stale/hand-edited state). */
function surfaceActiveTab(
  value: unknown,
  surface: 'files' | 'skills',
  openTabs: readonly string[],
): string | null {
  if (typeof value !== 'string' || !openTabs.includes(value)) return null;
  return isSkillTabId(value) === (surface === 'skills') ? value : null;
}

/** A fresh empty session — factory (not a shared const) so callers can't alias it. */
function emptyTabSessionState(): EditorTabSessionState {
  return {
    openTabs: [],
    pinnedTabIds: [],
    activeDocName: null,
    activeTabId: null,
    activeTabByMode: { files: null, skills: null },
    updatedAt: null,
  };
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
}

const LOCAL_TAB_SESSION_PREFIX = 'ok-editor-tabs-v1:';
const FOLDER_TAB_PREFIX = '\u0000folder:';
const ASSET_TAB_PREFIX = '\u0000asset:';
// Skill bundle files are addressed by three coordinates (scope / name / path),
// not a single path, so they get their own tab namespace. `name` carries no
// slash (lowercase-hyphen identity), so `scope/name/<path-tail>` parses back
// unambiguously even though `path` may contain slashes.
const SKILL_FILE_TAB_PREFIX = '\u0000skill-file:';
const SKILL_PREVIEW_TAB_PREFIX = '\u0000skill-preview:';
const TAB_INSTANCE_SEPARATOR = '\u0000doc-tab:';
// The Skills destination hub was a singleton full-pane tab. Nothing mints this
// id anymore; the constant survives only to prune it out of legacy persisted
// state. Matched EXACTLY rather than by `skills:` prefix — it is the one tab id
// with no `\u0000` sentinel, so a prefix test also swallowed a real content-root
// doc named `skills:…` (legal on POSIX), leaving it unopenable and routing its
// hash to the hub.
const SKILLS_HUB_TAB_ID = 'skills:hub';
const MARKDOWN_TAB_EXTENSION_PATTERN = /\.(md|mdx)$/i;

interface OpenTabOptions {
  behavior: 'append' | 'replace-active';
  currentTabId: string | null;
  limit: number;
  pinnedTabIds?: readonly string[];
}

function splitTabInstance(tabId: string): { baseTabId: string; instanceSuffix: string } {
  const separatorIndex = tabId.lastIndexOf(TAB_INSTANCE_SEPARATOR);
  if (separatorIndex < 0) return { baseTabId: tabId, instanceSuffix: '' };
  return {
    baseTabId: tabId.slice(0, separatorIndex),
    instanceSuffix: tabId.slice(separatorIndex),
  };
}

function baseTabId(tabId: string): string {
  return splitTabInstance(tabId).baseTabId;
}

function stripMarkdownTabExtension(path: string): string | null {
  return MARKDOWN_TAB_EXTENSION_PATTERN.test(path)
    ? path.replace(MARKDOWN_TAB_EXTENSION_PATTERN, '')
    : null;
}

function isValidTabId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  const base = baseTabId(value);
  if (base.startsWith(FOLDER_TAB_PREFIX)) return base.length > FOLDER_TAB_PREFIX.length;
  if (base.startsWith(ASSET_TAB_PREFIX)) return base.length > ASSET_TAB_PREFIX.length;
  if (base.startsWith(SKILL_FILE_TAB_PREFIX)) return parseSkillFileTabBody(base) !== null;
  // Skills is an ephemeral new-tab surface (`new-tab:skills:*`), never a standing
  // tab: `openTarget` opens it as a `new-tab:` placeholder that renders the Skills base page
  // without persisting. Reject the `skills:hub` id here so a stale standing tab
  // (from before the ephemeral move, or a rebase regression) is pruned on load
  // instead of restoring Skills as the default tab.
  if (base === SKILLS_HUB_TAB_ID) return false;
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
 * Find an already-open preview tab for the SAME LOCAL skill, keyed by
 * flavor + name + level and IGNORING the volatile `source` path. Both
 * local-path flavors move under you: a built-in's bundle path can differ
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
  flavor: Extract<SkillPreviewFlavor, 'builtin' | 'detected'>,
  name: string,
  scope: SkillScope,
): string | null {
  for (const id of openTabs) {
    const tab = parseEditorTabId(id);
    if (
      tab.kind === 'skill-preview' &&
      tab.flavor === flavor &&
      tab.name === name &&
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
      // No tab id: `isValidTabId` rejects the `skills:` prefix, so one could
      // never enter `openTabs`. The Skills destination is a sidebar section,
      // not an editor tab. The arm stays for exhaustiveness.
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
  | { kind: 'skills'; target: string }
  | {
      kind: 'skill-preview';
      flavor: SkillPreviewFlavor;
      source: string;
      name: string;
      subtitle: string;
      level?: SkillScope;
    } {
  const base = baseTabId(tabId);
  if (base.startsWith(FOLDER_TAB_PREFIX)) {
    return { kind: 'folder', folderPath: base.slice(FOLDER_TAB_PREFIX.length) };
  }
  if (base.startsWith(ASSET_TAB_PREFIX)) {
    return { kind: 'asset', assetPath: base.slice(ASSET_TAB_PREFIX.length) };
  }
  if (base === SKILLS_HUB_TAB_ID) {
    return { kind: 'skills', target: 'skills' };
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
 * True when a plain `doc` name belongs to a skill surface — a project skill's
 * SKILL.md / bundle file (under the skill content root) or a global `__skill__/`
 * managed artifact. Single source shared with `isSkillFocusedTarget`
 * (navigation-targets) so the tab-strip mode filter and the sidebar mode never
 * disagree on what counts as a skill.
 */
/**
 * Whether a tab session may be written back to storage.
 *
 * Not simply "did the restore succeed". A failed restore must not clobber a
 * session we could not READ — but gating on success alone meant one transient
 * failure disabled persistence for the whole session, silently dropping every
 * tab opened afterwards. Once the user actually has tabs open, that state is
 * worth more than the one we failed to read.
 */
export function shouldPersistTabSession(restoreSucceeded: boolean, openTabCount: number): boolean {
  return restoreSucceeded || openTabCount > 0;
}

export function isSkillDocName(docName: string): boolean {
  return (
    parseProjectSkillBundleDoc(docName) != null ||
    parseManagedArtifactName(docName)?.kind === 'skill' ||
    parseExternalSkillDocName(docName) != null
  );
}

/**
 * A bundle laid out like a skill but reached by a path `isSkillDocName` does not
 * name — the host roots it knows all start with a dot (`.claude/skills/…`).
 *
 * A skill dir can be a SYMLINK to somewhere else inside the content dir (a repo
 * that keeps its skills in `plugins/<x>/skills/` and links them into `.agents/`).
 * Both paths then index as documents, and a relative link in the body can resolve
 * to the real one — same bytes, a name that reads as ordinary content. Following
 * a reference out of a skill would drop the sidebar to Files, which looked like
 * the Skills surface had broken.
 *
 * Deliberately NOT folded into `isSkillDocName`: that parser also feeds the CC1
 * link index and managed-artifact resolution, where a looser shape would mint
 * skill edges for any document that happens to sit at this path. Widening only
 * the surface decision keeps the blast radius at "which sidebar is showing".
 */
const SKILL_BUNDLE_SHAPED_PATH = /(?:^|\/)skills\/[^/]+\/(?:SKILL|references\/.+)$/;

export function isSkillBundleShapedPath(docName: string): boolean {
  return SKILL_BUNDLE_SHAPED_PATH.test(docName);
}

/**
 * Classify a tab id as belonging to the Skills surface vs the Files surface,
 * from the id alone (no snapshot lookup). Skill tabs: the skills hub, read-only
 * bundle-file / skill-preview viewers, and `doc` tabs whose name is a skill doc.
 */
export function isSkillTabId(tabId: string): boolean {
  const tab = parseEditorTabId(tabId);
  return (
    tab.kind === 'skills' ||
    tab.kind === 'skill-file' ||
    tab.kind === 'skill-preview' ||
    (tab.kind === 'doc' && (isSkillDocName(tab.docName) || isSkillBundleShapedPath(tab.docName)))
  );
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

export function addOpenTab(
  tabs: readonly string[],
  tabId: string,
  limit: number,
  pinnedTabIds: readonly string[] = [],
): string[] {
  const normalized = capOpenTabsPreservingPinned(tabs, limit, pinnedTabIds);
  if (!isValidTabId(tabId) || normalized.includes(tabId)) return normalized;
  const next = [...normalized, tabId];
  return capOpenTabsPreservingPinned(next, limit, pinnedTabIds);
}

export function replaceOpenTab(
  tabs: readonly string[],
  currentTabId: string | null,
  nextTabId: string,
  limit: number,
  pinnedTabIds: readonly string[] = [],
): string[] {
  const normalized = capOpenTabsPreservingPinned(tabs, limit, pinnedTabIds);
  if (!isValidTabId(nextTabId)) return normalized;
  if (!currentTabId || currentTabId === nextTabId) {
    return addOpenTab(normalized, nextTabId, limit, pinnedTabIds);
  }

  const tabsWithoutNext = normalized.filter((tab) => tab !== nextTabId);
  const currentIndex = tabsWithoutNext.indexOf(currentTabId);
  if (currentIndex < 0) return addOpenTab(tabsWithoutNext, nextTabId, limit, pinnedTabIds);

  const next = [...tabsWithoutNext];
  next[currentIndex] = nextTabId;
  return capOpenTabsPreservingPinned(next, limit, pinnedTabIds);
}

export function openDocTab(
  tabs: readonly string[],
  docName: string,
  options: OpenTabOptions,
): { tabs: string[]; activeTabId: string } {
  return openTab(tabs, docTabId(docName), options);
}

export function openTab(
  tabs: readonly string[],
  tabId: string,
  { behavior, currentTabId, limit, pinnedTabIds = [] }: OpenTabOptions,
): { tabs: string[]; activeTabId: string } {
  const normalized = capOpenTabsPreservingPinned(tabs, limit, pinnedTabIds);
  const canonicalTabId = baseTabId(tabId);
  if (
    currentTabId &&
    normalized.includes(currentTabId) &&
    baseTabId(currentTabId) === canonicalTabId
  ) {
    return {
      tabs: normalized,
      activeTabId: currentTabId,
    };
  }
  // Focus an already-open tab for this target rather than opening a second tab
  // for the same doc/folder/asset. Without this, opening a target that is open
  // in a non-active tab — or while a blank new-tab is active — would mint a
  // duplicate tab for the same file.
  const existingTabId = normalized.find((openTabId) => baseTabId(openTabId) === canonicalTabId);
  if (existingTabId) {
    return {
      tabs: normalized,
      activeTabId: existingTabId,
    };
  }
  if (behavior !== 'replace-active') {
    return {
      tabs: addOpenTab(normalized, canonicalTabId, limit, pinnedTabIds),
      activeTabId: canonicalTabId,
    };
  }

  return {
    tabs: replaceOpenTab(normalized, currentTabId, canonicalTabId, limit, pinnedTabIds),
    activeTabId: canonicalTabId,
  };
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
  }: KnownTabTargets,
): string[] {
  return normalizeOpenTabs(tabs, Number.MAX_SAFE_INTEGER).filter((tabId) => {
    const tab = parseEditorTabId(tabId);
    if (tab.kind === 'folder') return folderPaths.has(tab.folderPath);
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
    // Skills is an ephemeral new-tab surface, not a standing tab: drop any
    // persisted `skills:hub` so a page-list sync doesn't resurrect it.
    if (tab.kind === 'skills') return false;
    const markdownStem = stripMarkdownTabExtension(tab.docName);
    return (
      pages.has(tab.docName) ||
      (markdownStem !== null && pages.has(markdownStem)) ||
      // Managed-artifact docs (skills/templates) are tree-excluded by design, so
      // they never appear in `pages` — keep their tabs regardless, otherwise the
      // page-list sync would prune the active skill/template tab the moment a
      // page-list update fires (e.g. right after opening it).
      isManagedArtifactDocName(tab.docName) ||
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
    const { instanceSuffix } = splitTabInstance(tab);
    const parsed = parseEditorTabId(tab);
    // Skill-file tabs aren't renameable doc/folder/asset paths — pass through.
    const mappedBase =
      parsed.kind === 'doc'
        ? remapDocTabBase(parsed.docName, baseTabId(tab))
        : parsed.kind === 'folder'
          ? folderTabId(remapPathForFolderRenames(parsed.folderPath, folderMappings))
          : parsed.kind === 'asset'
            ? remapAssetTabBase(parsed.assetPath)
            : baseTabId(tab);
    const mapped = `${mappedBase}${instanceSuffix}`;
    if (seen.has(mapped)) continue;
    seen.add(mapped);
    next.push(mapped);
    if (pinnedTabIds.length === 0 && next.length >= limit) break;
  }
  if (pinnedTabIds.length === 0) return next;
  const remappedPinnedTabIds = pinnedTabIds.map((tabId) => {
    const parsed = parseEditorTabId(tabId);
    return parsed.kind === 'doc'
      ? remapDocTabBase(parsed.docName, tabId)
      : parsed.kind === 'folder'
        ? folderTabId(remapPathForFolderRenames(parsed.folderPath, folderMappings))
        : parsed.kind === 'asset'
          ? remapAssetTabBase(parsed.assetPath)
          : baseTabId(tabId);
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

export function parseEditorTabSessionState(value: unknown, limit: number): EditorTabSessionState {
  if (typeof value !== 'object' || value === null) {
    return emptyTabSessionState();
  }
  const record = value as Record<string, unknown>;
  const rawOpenTabs = normalizeOpenTabs(record.openTabs, Number.MAX_SAFE_INTEGER);
  const rawPinnedTabIds = normalizePinnedTabIds(record.pinnedTabIds, rawOpenTabs);
  const openTabs =
    rawPinnedTabIds.length === 0
      ? normalizeOpenTabs(record.openTabs, limit)
      : capOpenTabsPreservingPinned(rawOpenTabs, limit, rawPinnedTabIds);
  const pinnedTabIds = normalizePinnedTabIds(record.pinnedTabIds, openTabs);
  const activeTabId =
    typeof record.activeTabId === 'string' && openTabs.includes(record.activeTabId)
      ? record.activeTabId
      : typeof record.activeDocName === 'string' && openTabs.includes(record.activeDocName)
        ? record.activeDocName
        : null;
  const activeTab = activeTabId ? parseEditorTabId(activeTabId) : null;
  const rawActiveByMode: Record<string, unknown> =
    typeof record.activeTabByMode === 'object' &&
    record.activeTabByMode !== null &&
    !Array.isArray(record.activeTabByMode)
      ? (record.activeTabByMode as Record<string, unknown>)
      : {};
  return {
    openTabs,
    pinnedTabIds,
    activeDocName: activeTab?.kind === 'doc' ? activeTab.docName : null,
    activeTabId,
    activeTabByMode: {
      files: surfaceActiveTab(rawActiveByMode.files, 'files', openTabs),
      skills: surfaceActiveTab(rawActiveByMode.skills, 'skills', openTabs),
    },
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
  };
}

export function createEditorTabSessionState(
  openTabs: readonly string[],
  activeTabId: string | null,
  pinnedTabIds: readonly string[] = [],
  activeTabByMode: { files: string | null; skills: string | null } = {
    files: null,
    skills: null,
  },
  now: () => Date = () => new Date(),
): EditorTabSessionState {
  const normalized = normalizeOpenTabs(openTabs, Number.MAX_SAFE_INTEGER);
  const normalizedActiveTabId =
    activeTabId && normalized.includes(activeTabId) ? activeTabId : null;
  const activeTab = normalizedActiveTabId ? parseEditorTabId(normalizedActiveTabId) : null;
  return {
    openTabs: normalized,
    pinnedTabIds: normalizePinnedTabIds(pinnedTabIds, normalized),
    activeDocName: activeTab?.kind === 'doc' ? activeTab.docName : null,
    activeTabId: normalizedActiveTabId,
    activeTabByMode: {
      files: surfaceActiveTab(activeTabByMode.files, 'files', normalized),
      skills: surfaceActiveTab(activeTabByMode.skills, 'skills', normalized),
    },
    updatedAt: now().toISOString(),
  };
}

export function localTabSessionStorageKey(projectKey: string): string {
  return `${LOCAL_TAB_SESSION_PREFIX}${projectKey}`;
}

export function readLocalTabSessionState(
  storage: Pick<Storage, 'getItem'> | null,
  key: string,
  limit: number,
): EditorTabSessionState {
  if (!storage) {
    return emptyTabSessionState();
  }
  try {
    const raw = storage.getItem(key);
    if (!raw) {
      return emptyTabSessionState();
    }
    return parseEditorTabSessionState(JSON.parse(raw), limit);
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
    storage.setItem(key, JSON.stringify(state));
  } catch (err) {
    console.warn('[editor-tabs] failed to write local tab session:', err);
    // Private browsing and quota failures should not affect editing.
  }
}
