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

function isSkillScope(value: string): value is SkillScope {
  return (MANAGED_ARTIFACT_SCOPES as readonly string[]).includes(value);
}

export interface EditorTabSessionState {
  updatedAt: string | null;
  panes: PersistedEditorPane[];
  focusedPaneId: string;
}

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
  keepHashDocName?: string | null;
  keepFolderPaths?: ReadonlySet<string>;
}

const EMPTY_FOLDER_PATHS: ReadonlySet<string> = new Set<string>();
const LOCAL_TAB_SESSION_PREFIX = 'ok-editor-tabs-v1:';
const FOLDER_TAB_PREFIX = '\u0000folder:';
const ASSET_TAB_PREFIX = '\u0000asset:';
const SKILL_FILE_TAB_PREFIX = '\u0000skill-file:';
const SKILL_PREVIEW_TAB_PREFIX = '\u0000skill-preview:';
const MARKDOWN_TAB_EXTENSION_PATTERN = /\.(md|mdx)$/i;

function stripMarkdownTabExtension(path: string): string | null {
  return MARKDOWN_TAB_EXTENSION_PATTERN.test(path)
    ? path.replace(MARKDOWN_TAB_EXTENSION_PATTERN, '')
    : null;
}

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

function persistedTabIds(panes: readonly unknown[]): string[] {
  return panes.flatMap((pane) => {
    if (typeof pane !== 'object' || pane === null) return [];
    const openTabs = (pane as Record<string, unknown>).openTabs;
    if (!Array.isArray(openTabs)) return [];
    return openTabs.filter((tabId): tabId is string => typeof tabId === 'string');
  });
}

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

export interface SkillFileTabTarget {
  scope: SkillScope;
  name: string;
  path: string;
  host?: string;
}

const SKILL_FILE_TAB_HOST_SEP = ':';

export function skillFileTabId(target: SkillFileTabTarget): string {
  const named =
    target.host === undefined
      ? target.name
      : `${target.name}${SKILL_FILE_TAB_HOST_SEP}${target.host}`;
  return `${SKILL_FILE_TAB_PREFIX}${target.scope}/${named}/${target.path}`;
}

function parseSkillFileTabBody(base: string): SkillFileTabTarget | null {
  if (!base.startsWith(SKILL_FILE_TAB_PREFIX)) return null;
  const body = base.slice(SKILL_FILE_TAB_PREFIX.length);
  const segments = body.split('/');
  if (segments.length < 3) return null;
  const [scope, named, ...rest] = segments;
  const path = rest.join('/');
  if (!scope || !named || !path || !isSkillScope(scope)) return null;
  const sep = named.indexOf(SKILL_FILE_TAB_HOST_SEP);
  const name = sep === -1 ? named : named.slice(0, sep);
  const host = sep === -1 ? undefined : named.slice(sep + 1);
  if (!name) return null;
  return { scope, name, path, ...(host ? { host } : {}) };
}

export function skillPreviewTabId(target: SkillPreviewHashTarget): string {
  return `${SKILL_PREVIEW_TAB_PREFIX}${encodeSkillPreviewSegments(target)}`;
}

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

export function tabParts(
  docName: string,
  docExt: string,
): { baseName: string; extension: string; label: string; prefix: string } {
  const projectSkill = parseProjectSkillContentDocName(docName);
  if (projectSkill) {
    const display = skillDisplayName(projectSkill);
    return { baseName: display, extension: '', label: display, prefix: '' };
  }
  const extSkill = parseExternalSkillDocName(docName);
  if (extSkill) {
    const display = extSkill.rel
      ? (extSkill.rel.split('/').pop() ?? extSkill.rel)
      : skillDisplayName(extSkill.name);
    return { baseName: display, extension: '', label: display, prefix: '' };
  }
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

export type TabSessionRestoreOutcome = 'applied' | 'unread' | 'suppressed';

export function shouldPersistTabSession(
  restoreOutcome: TabSessionRestoreOutcome,
  openTabCount: number,
): boolean {
  if (restoreOutcome === 'suppressed') return false;
  return restoreOutcome === 'applied' || openTabCount > 0;
}

export function isSkillDocName(docName: string): boolean {
  return (
    parseProjectSkillBundleDoc(docName) != null ||
    parseManagedArtifactName(docName)?.kind === 'skill' ||
    parseExternalSkillDocName(docName) != null
  );
}

const SKILL_BUNDLE_ROOT_PATH = /(?:^|\/)\.[A-Za-z0-9_-]+\/skills\/[^/]+\/.+$/;

export function isSkillBundleShapedPath(docName: string): boolean {
  if (SKILL_BUNDLE_ROOT_PATH.test(docName)) return true;
  const known = getKnownProjectSkillDirs();
  if (known.size === 0) return false;
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

export function applyDragPinMutation(
  nextOpenTabs: readonly string[],
  pinnedTabIds: readonly string[],
  draggedTabId: string,
): string[] {
  const normalizedOpen = normalizeOpenTabs(nextOpenTabs, Number.MAX_SAFE_INTEGER);
  const prevPinned = normalizePinnedTabIds(pinnedTabIds, normalizedOpen);
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
    if (tab.kind === 'skill-file') return true;
    if (tab.kind === 'skill-preview') return true;
    if (tab.kind === 'doc' && parseProjectSkillBundleDoc(tab.docName)?.kind === 'skill') {
      return true;
    }
    const markdownStem = stripMarkdownTabExtension(tab.docName);
    return (
      pages.has(tab.docName) ||
      (markdownStem !== null && pages.has(markdownStem)) ||
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
  }
}
