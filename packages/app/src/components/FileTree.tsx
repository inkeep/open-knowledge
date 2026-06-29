import {
  type Config,
  type ConfigBinding,
  CreateFolderSuccessSchema,
  CreatePageSuccessSchema,
  DeletePathSuccessSchema,
  DocumentListSuccessSchema,
  DuplicatePathSuccessSchema,
  type HandoffOutcome,
  type HandoffTarget,
  humanFormat,
  type InstallState,
  isDocumentOverOpenByteLimit,
  type OkignoreBinding,
  RenamePathSuccessSchema,
  TrashCleanupSuccessSchema,
  UploadAssetSuccessSchema,
  WorkspaceSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { plural, t } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  type ContextMenuItem,
  type ContextMenuOpenContext,
  FILE_TREE_TAG_NAME,
  type FileTreeDropResult,
  type FileTreeRenameEvent,
  type FileTree as PierreFileTreeModel,
} from '@pierre/trees';
import { FileTree as PierreFileTree, useFileTree } from '@pierre/trees/react';
import {
  Copy,
  CopyPlus,
  EyeOff,
  FilePlus,
  FolderOpen,
  FolderPlus,
  FoldVertical,
  Info,
  Pencil,
  RefreshCw,
  SquarePen,
  Trash2,
  TriangleAlert,
  UnfoldVertical,
} from 'lucide-react';
import { __iconNode as botIcon } from 'lucide-react/dist/esm/icons/bot';
import { __iconNode as link2Icon } from 'lucide-react/dist/esm/icons/link-2';
import { useTheme } from 'next-themes';
import {
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type Ref,
  startTransition,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import { DeleteConfirmationDialog } from '@/components/DeleteConfirmationDialog';
import {
  MARKDOWN_FILE_ICON_PATH_D,
  MARKDOWN_FILE_ICON_VIEWBOX,
} from '@/components/file-entry-icon';
import {
  collectTreeFolderPathsFromDocuments,
  computeTreeAncestorPaths,
  computeTreeDropDestinationPath,
  createPagePathFromTreeDestination,
  createTreePlaceholder,
  docNameToTreePath,
  documentsToTreePaths,
  documentsTreePathSignature,
  fileEntryFromUploadedPath,
  fileEntryToTreePath,
  filesFromExternalDrop,
  folderPathToTreeDirectoryPath,
  isExternalFileDrag,
  normalizeTreePathForKind,
  parentFolderPathForTreeItemDropTarget,
  relativePathForTreeItem,
  treeDirectoryPathToFolderPath,
  treeFilePathToDocName,
  treeItemToTarget,
  treePathSignature,
  treePathToAppPath,
  uploadedPathForSidebarDrop,
  uploadParentDocNameForFolderDrop,
} from '@/components/file-tree-adapter';
import {
  createFileTreeStyle,
  FILE_TREE_DENSITY_OPTIONS,
  FILE_TREE_INDENT_GUIDE_CSS,
  FILE_TREE_STICKY_HEADER_CSS,
} from '@/components/file-tree-density';
import {
  applyExtensionBadges,
  FILE_TREE_EXT_BADGE_CSS,
} from '@/components/file-tree-extension-badge';
import { buildOkignorePatternFromTarget } from '@/components/file-tree-okignore';
import {
  applyDeleteToDocuments,
  applyDuplicateToDocuments,
  applyRenameToDocuments,
  buildTrashAbsPath,
  canonicalizeAssetTargetForDelete,
  type FileTreeTarget,
  planRenameCleanupCalls,
  type RenamedAssetMapping,
  type RenamedDocExtensionMapping,
  type RenamedDocMapping,
  type RenamedFolderMapping,
  remapActiveDocName,
} from '@/components/file-tree-operations';
import {
  applyRenameInputAffordance,
  FILE_TREE_RENAME_INPUT_CSS,
} from '@/components/file-tree-rename-chip';
import {
  getFileExtension,
  hasSupportedDocumentExtension,
  validateAndCoerceRenameDestination,
} from '@/components/file-tree-rename-validation';
import { revealActiveRow } from '@/components/file-tree-reveal';
import {
  resolveFileTreeSelection,
  resolveFileTreeSelectionAction,
} from '@/components/file-tree-selection';
import { selectTrashConfirmCopy, trashTargetDisplayName } from '@/components/file-tree-trash-copy';
import {
  type DocumentEntry,
  type FileEntry,
  type FolderEntry,
  filterVisibleEntries,
  isAssetEntry,
  isDocumentEntry,
  isFolderEntry,
  toFileEntries,
} from '@/components/file-tree-utils';
import { NewItemDialog } from '@/components/NewItemDialog';
import {
  largeFileNavigationTarget,
  type ResolvedNavigationTarget,
} from '@/components/navigation-targets';
import { usePageList } from '@/components/PageListContext';
import {
  appendPattern,
  parseOkignoreDoc,
  serializeOkignoreDoc,
} from '@/components/settings/okignore-doc';
import { sidebarDragPayloadForTreePath } from '@/components/sidebar-drag-payload';
import {
  coerceTrashFailureReason,
  type TrashFailedTarget,
  TrashFailureModal,
} from '@/components/TrashFailureModal';
import { TemplateMenuRows } from '@/components/template-menu-rows';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { asDirectoryHandle, useSelectionMirror } from '@/components/use-selection-mirror';
import { getEditorForDoc } from '@/editor/active-editor';
import { useDocumentContext } from '@/editor/DocumentContext';
import { captureRenameSnapshots } from '@/editor/editor-cache';
import { assetTabId, docTabId, folderTabId, remapPathForFolderRenames } from '@/editor/editor-tabs';
import { useConflicts } from '@/hooks/use-conflicts';
import { useFolderConfig } from '@/hooks/use-folder-config';
import { useConfigContext } from '@/lib/config-provider';
import {
  hashFromAssetPath,
  hashFromDocName,
  hashFromFolderPath,
  replaceHashWithoutNavigation,
} from '@/lib/doc-hash';
import { emitDocumentsChanged, subscribeToDocumentsChanged } from '@/lib/documents-events';
import {
  subscribeToFileTreeMenuActionDelete,
  subscribeToFileTreeMenuActionDuplicate,
  subscribeToFileTreeMenuActionRename,
} from '@/lib/file-tree-menu-action-events';
import { parseServerResponse, parseSuccessOrWarn } from '@/lib/parse-server-response';
import { createRefreshScheduler } from '@/lib/refresh-scheduler';
import { getRelaunchInFlightSnapshot, useRelaunchInFlight } from '@/lib/relaunch-store';
import {
  consumeShowAllStream,
  isNdjsonResponse,
  SHOW_ALL_NDJSON_ACCEPT,
  ShowAllStreamError,
} from '@/lib/show-all-stream';
import { OK_SIDEBAR_DRAG_MIME, serializeSidebarDragPayload } from '@/lib/sidebar-drag';
import { cn } from '@/lib/utils';
import { joinWorkspacePath } from '@/lib/workspace-paths';
import { spliceLazyFolderChildren } from './file-tree-merge';
import { OpenInAgentContextSubmenu } from './handoff/OpenInAgentContextSubmenu';
import {
  buildFolderHandoffInput,
  buildHandoffInput,
  type HandoffDispatchInput,
  useHandoffDispatch,
} from './handoff/useHandoffDispatch';
import { useInstalledAgents } from './handoff/useInstalledAgents';
import { cancelHoverPrewarm, scheduleHoverPrewarm } from './sidebar-hover-prewarm';
import { useSidebar } from './ui/sidebar';

const MARKDOWN_TREE_EXTENSION_PATTERN = /\.(md|mdx)$/i;

function parseAlreadyExistsRenamePath(message: string): string | null {
  const match = message.match(/^"(.+)" already exists\.$/);
  return match ? match[1] : null;
}

function markdownTreeExtension(path: string): string | null {
  const match = path.match(MARKDOWN_TREE_EXTENSION_PATTERN);
  return match ? match[0] : null;
}

function focusEditorAfterRename(docName: string): void {
  window.requestAnimationFrame(() => {
    const editor = getEditorForDoc(docName);
    if (!editor || editor.isDestroyed) return;
    try {
      editor.commands.focus();
    } catch {
    }
  });
}

interface ExternalFileDropTarget {
  parentDir: string;
  row: HTMLElement | null;
  root: HTMLElement | null;
  busyPath: string;
}

interface ExternalFileDropAffordanceRef {
  current: {
    row: HTMLElement | null;
    root: HTMLElement | null;
  };
}

function clearExternalFileDropAffordance(ref: ExternalFileDropAffordanceRef) {
  const current = ref.current;
  current.row?.removeAttribute(FILE_TREE_EXTERNAL_FILE_DROP_TARGET_ATTR);
  current.root?.removeAttribute(FILE_TREE_EXTERNAL_FILE_DROP_ROOT_ATTR);
  ref.current = { row: null, root: null };
}

function setExternalFileDropAffordance(
  ref: ExternalFileDropAffordanceRef,
  target: ExternalFileDropTarget,
) {
  const current = ref.current;
  if (current.row === target.row && current.root === target.root) return;
  clearExternalFileDropAffordance(ref);
  target.row?.setAttribute(FILE_TREE_EXTERNAL_FILE_DROP_TARGET_ATTR, 'true');
  target.root?.setAttribute(FILE_TREE_EXTERNAL_FILE_DROP_ROOT_ATTR, 'true');
  ref.current = { row: target.row, root: target.root };
}

async function copyToClipboard(text: string, kind: 'full' | 'relative'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(kind === 'full' ? t`Copied full path` : t`Copied relative path`, {
      description: text,
    });
  } catch (err) {
    console.warn('[FileTree] clipboard write failed:', err);
    toast.error(kind === 'full' ? t`Could not copy full path` : t`Could not copy relative path`);
  }
}

const AGENT_FILE_NAMES = new Set(['agents', 'agent', 'claude', 'skill']);
const LINK_DECORATION_ICON_ID = 'ok-file-tree-link-decoration';
const AGENT_DECORATION_ICON_ID = 'ok-file-tree-agent-decoration';
const MARKDOWN_FILE_ICON_ID = 'ok-file-tree-markdown';
const MARKDOWN_FILE_ICON_SYMBOL = `<symbol id="${MARKDOWN_FILE_ICON_ID}" viewBox="${MARKDOWN_FILE_ICON_VIEWBOX}" fill="currentColor"><path d="${MARKDOWN_FILE_ICON_PATH_D}"/></symbol>`;

type IconNode = [string, Record<string, string>][];

function iconNodeToSvg(iconNode: IconNode): string {
  return (
    iconNode
      .map(([tag, { key: _, ...attrs }]) => {
        const attrString = Object.entries(attrs)
          .map(([k, v]) => `${k}="${v}"`)
          .join(' ');
        return `<${tag} ${attrString} />`;
      })
      .join('')
  );
}

function createLucideSpriteSymbol(id: string, iconNode: IconNode): string {
  const symbolContent = iconNodeToSvg(iconNode);
  return `<symbol id="${id}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${symbolContent}</symbol>`;
}

const FILE_TREE_DECORATION_SPRITE_SHEET = `<svg data-icon-sprite aria-hidden="true" width="0" height="0">
  ${createLucideSpriteSymbol(LINK_DECORATION_ICON_ID, link2Icon)}
  ${createLucideSpriteSymbol(AGENT_DECORATION_ICON_ID, botIcon)}
  ${MARKDOWN_FILE_ICON_SYMBOL}
</svg>`;

const FILE_TREE_ROOT_DROP_CSS = `
  [data-file-tree-virtualized-root][data-file-tree-root-drag-target="true"] {
    position: relative;
  }
  [data-file-tree-virtualized-root][data-file-tree-root-drag-target="true"]::after {
    content: "";
    position: absolute;
    inset: 0;
    z-index: 20;
    border-radius: 0.375rem;
    box-shadow: inset 0 0 0 2px color-mix(in oklab, var(--color-primary) 80%, transparent);
    background: color-mix(in oklab, var(--color-primary) 6%, transparent);
    pointer-events: none;
  }
  /* Forced-colors (Windows High Contrast) suppresses box-shadow and overrides
     color-mix backgrounds, so the ring above would vanish. Borders survive
     forced-colors — fall back to a system Highlight border (mirrors the JSX
     in-range halo fallback in globals.css). */
  @media (forced-colors: active) {
    [data-file-tree-virtualized-root][data-file-tree-root-drag-target="true"]::after {
      border: 2px solid Highlight;
    }
  }
`;

const FILE_TREE_EXTERNAL_FILE_DROP_TARGET_ATTR = 'data-ok-external-file-drop-target';
const FILE_TREE_EXTERNAL_FILE_DROP_ROOT_ATTR = 'data-ok-external-file-drop-root-target';
const FILE_TREE_EXTERNAL_FILE_DROP_BUSY_PATH = '__external-file-drop__';

const CONNECTIVITY_RECONNECT_RETRY_MS = 2000;
const FILE_TREE_EXTERNAL_FILE_DROP_CSS = `
  [data-type="item"][${FILE_TREE_EXTERNAL_FILE_DROP_TARGET_ATTR}="true"] {
    background: color-mix(in oklab, var(--color-primary) 10%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--color-primary) 72%, transparent);
  }
  [data-file-tree-virtualized-root][${FILE_TREE_EXTERNAL_FILE_DROP_ROOT_ATTR}="true"] {
    position: relative;
  }
  [data-file-tree-virtualized-root][${FILE_TREE_EXTERNAL_FILE_DROP_ROOT_ATTR}="true"]::after {
    content: "";
    position: absolute;
    inset: 0;
    z-index: 20;
    border-radius: 0.375rem;
    box-shadow: inset 0 0 0 2px color-mix(in oklab, var(--color-primary) 80%, transparent);
    background: color-mix(in oklab, var(--color-primary) 6%, transparent);
    pointer-events: none;
  }
  @media (forced-colors: active) {
    [data-type="item"][${FILE_TREE_EXTERNAL_FILE_DROP_TARGET_ATTR}="true"] {
      outline: 2px solid Highlight;
      outline-offset: -2px;
    }
    [data-file-tree-virtualized-root][${FILE_TREE_EXTERNAL_FILE_DROP_ROOT_ATTR}="true"]::after {
      border: 2px solid Highlight;
    }
  }
`;

const FILE_TREE_CREATION_CLEARED_ATTR = 'data-ok-creation-cleared';
const FILE_TREE_CREATION_CLEARED_CSS = `
  :host([${FILE_TREE_CREATION_CLEARED_ATTR}]) [data-item-focused="true"] {
    --trees-focus-ring-color: transparent;
  }
`;

const FILE_TREE_UNSAFE_CSS = `${FILE_TREE_EXT_BADGE_CSS}\n${FILE_TREE_RENAME_INPUT_CSS}\n${FILE_TREE_ROOT_DROP_CSS}\n${FILE_TREE_EXTERNAL_FILE_DROP_CSS}\n${FILE_TREE_CREATION_CLEARED_CSS}\n${FILE_TREE_INDENT_GUIDE_CSS}\n${FILE_TREE_STICKY_HEADER_CSS}`;

function isAgentTreePath(treePath: string): boolean {
  const name = treePath.split('/').pop()?.replace(/\.md$/i, '').toLowerCase();
  return !!name && AGENT_FILE_NAMES.has(name);
}

interface PendingCreate {
  kind: 'file' | 'folder';
  renamePath: string;
  createdPath: string;
  previousHash: string;
  disposeCommitListener: () => void;
}

interface PendingCreateCleanupOptions {
  updateUi?: boolean;
  restoreLocation?: boolean;
}

interface FileTreeDeleteRequest {
  targets: FileTreeTarget[];
}

interface TrashFailureRequest {
  failed: TrashFailedTarget[];
  originalTargets: FileTreeTarget[];
}

interface WorkspaceInfo {
  contentDir: string;
  pathSeparator: '/' | '\\';
}

function revealInFileManagerLabel(platform: 'darwin' | 'win32' | 'linux'): string {
  if (platform === 'darwin') return t`Reveal in Finder`;
  if (platform === 'win32') return t`Reveal in File Explorer`;
  return t`Open containing folder`;
}

function RevealInFileManagerMenuItem({
  item,
  workspace,
  onClose,
}: {
  item: ContextMenuItem;
  workspace: WorkspaceInfo | null;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const bridge = typeof window !== 'undefined' ? window.okDesktop : undefined;
  if (!bridge) return null;
  const platform = bridge.platform;
  const label = revealInFileManagerLabel(platform);
  const hint = !workspace ? t`No workspace` : null;
  const ariaLabel =
    platform === 'darwin'
      ? hint
        ? t`Reveal in Finder, ${hint}`
        : t`Reveal in Finder`
      : platform === 'win32'
        ? hint
          ? t`Reveal in File Explorer, ${hint}`
          : t`Reveal in File Explorer`
        : hint
          ? t`Open containing folder, ${hint}`
          : t`Open containing folder`;
  return (
    <DropdownMenuItem
      disabled={!workspace}
      onSelect={() => {
        if (!workspace) return;
        onClose();
        const full = joinWorkspacePath(
          workspace.contentDir,
          relativePathForTreeItem(item),
          workspace.pathSeparator,
        );
        void bridge.shell.showItemInFolder(full);
      }}
      aria-label={ariaLabel}
    >
      <FolderOpen aria-hidden="true" />
      <span className="flex-1">{label}</span>
      {hint ? (
        <span aria-hidden="true" className="ml-2 text-muted-foreground text-xs">
          {hint}
        </span>
      ) : null}
    </DropdownMenuItem>
  );
}

interface FileTreeMenuProps {
  item: ContextMenuItem;
  context: ContextMenuOpenContext;
  anyActionBusy: boolean;
  workspace: WorkspaceInfo | null;
  handoff: {
    readonly installStates: Record<HandoffTarget, InstallState>;
    readonly isElectronHost: boolean;
    readonly dispatch: (
      target: HandoffTarget,
      input: HandoffDispatchInput,
    ) => Promise<HandoffOutcome>;
  };
  model: PierreFileTreeModel;
  okignoreBinding: OkignoreBinding | null;
  /** Project-local config binding for the `Show hidden files` folder-menu
   *  toggle. Patched directly here (mirrors the okignore Hide flow); `null`
   *  during cold-start disables the toggle item. */
  projectLocalBinding: ConfigBinding | null;
  /** Layered config view, source for the toggle check-state
   *  (`appearance.sidebar.showHiddenFiles`). */
  mergedConfig: Config | null;
  onStartCreating: (kind: 'file' | 'folder', parentDir: string) => void;
  /** Inline create-from-template for the given parent dir + template name —
   *  same inline-rename fast path as `onStartCreating`, seeded from a template.
   *  Drives the folder menu's "New from template" hover submenu. */
  onCreateFromTemplate: (parentDir: string, templateName: string) => void;
  onDuplicate: (target: FileTreeTarget) => void;
  onDelete: (targets: FileTreeTarget[]) => void;
  onExpandSubtree: (treePath: string) => void;
  onCollapseSubtree: (treePath: string) => void;
  folderTreePaths: readonly string[];
  isAsset: boolean;
  /** Authoritative document list — sourced for `docExt` when Pierre's tree
   *  path has lost its extension after a basename-only commit. See `treeItemToTarget`. */
  documents: readonly FileEntry[];
}

function treePathToTarget(treePath: string, documents: readonly FileEntry[]): FileTreeTarget {
  return treeItemToTarget(
    {
      kind: treePath.endsWith('/') ? 'directory' : 'file',
      name: treePath,
      path: treePath,
    },
    documents,
  );
}

function isTreePathInsideFolder(treePath: string, folderTreePath: string): boolean {
  return treePath !== folderTreePath && treePath.startsWith(folderTreePath);
}

function selectedTreePathsToDeleteTargets(
  selectedTreePaths: readonly string[],
  documents: readonly FileEntry[],
): FileTreeTarget[] {
  const uniqueDeletablePaths = [...new Set(selectedTreePaths)];
  const selectedFolderPaths = uniqueDeletablePaths.filter((treePath) => treePath.endsWith('/'));
  return uniqueDeletablePaths
    .filter(
      (treePath) =>
        !selectedFolderPaths.some((folderPath) => isTreePathInsideFolder(treePath, folderPath)),
    )
    .map((treePath) => treePathToTarget(treePath, documents));
}

function isPathAtOrInsideFolder(path: string, folderPath: string): boolean {
  return path === folderPath || path.startsWith(`${folderPath}/`);
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName;
  return (
    tagName === 'INPUT' ||
    tagName === 'TEXTAREA' ||
    tagName === 'SELECT' ||
    target.isContentEditable ||
    target.closest('[contenteditable="true"]') !== null
  );
}

function collectTabsToCloseForDelete(
  targets: readonly FileTreeTarget[],
  documents: readonly FileEntry[],
  folderTreePaths: readonly string[],
): { docNames: Set<string>; folderPaths: Set<string>; assetPaths: Set<string> } {
  const docNames = new Set<string>();
  const folderPaths = new Set<string>();
  const assetPaths = new Set<string>();

  for (const target of targets) {
    if (target.kind === 'file') {
      docNames.add(target.path);
      continue;
    }
    if (target.kind === 'asset') {
      assetPaths.add(target.path);
      continue;
    }

    folderPaths.add(target.path);
    for (const entry of documents) {
      if (isDocumentEntry(entry) && entry.docName.startsWith(`${target.path}/`)) {
        docNames.add(entry.docName);
      } else if (isAssetEntry(entry) && entry.path.startsWith(`${target.path}/`)) {
        assetPaths.add(entry.path);
      }
    }
    for (const treePath of folderTreePaths) {
      const folderPath = treeDirectoryPathToFolderPath(treePath);
      if (isPathAtOrInsideFolder(folderPath, target.path)) {
        folderPaths.add(folderPath);
      }
    }
  }

  return { docNames, folderPaths, assetPaths };
}

function deleteTargetCoversPendingCreate(target: FileTreeTarget, pending: PendingCreate): boolean {
  if (target.kind === 'file') {
    return pending.kind === 'file' && target.path === pending.createdPath;
  }
  if (target.kind === 'asset') return false;
  return isPathAtOrInsideFolder(pending.createdPath, target.path);
}

function FileTreeMenu({
  item,
  context,
  anyActionBusy,
  workspace,
  handoff,
  model,
  okignoreBinding,
  projectLocalBinding,
  mergedConfig,
  onStartCreating,
  onCreateFromTemplate,
  onDuplicate,
  onDelete,
  onExpandSubtree,
  onCollapseSubtree,
  folderTreePaths,
  isAsset,
  documents,
}: FileTreeMenuProps) {
  const { t } = useLingui();
  const target = treeItemToTarget(item, documents);
  const isFolder = item.kind === 'directory';
  const okignoreTarget = target.kind === 'asset' ? null : target;
  const canHide = okignoreTarget !== null && okignoreBinding !== null;
  const hideLabel = isFolder ? t`Hide folder` : t`Hide this file`;
  const showHiddenFiles = mergedConfig?.appearance?.sidebar?.showHiddenFiles ?? false;
  const canToggleVisibility = projectLocalBinding !== null;
  const folderConfig = useFolderConfig(isFolder ? treeDirectoryPathToFolderPath(item.path) : null);
  const folderHasTemplates =
    folderConfig.state.status === 'ready'
      ? (folderConfig.state.data.folder.templates_available?.length ?? 0) > 0
      : true;
  const selectedTreePaths = model.getSelectedPaths();
  const selectedDeleteTargets = selectedTreePaths.includes(target.treePath)
    ? selectedTreePathsToDeleteTargets(selectedTreePaths, documents)
    : [];
  const deleteTargets = selectedDeleteTargets.length > 1 ? selectedDeleteTargets : [target];
  const deleteCount = deleteTargets.length;
  const deleteLabel = plural(deleteCount, { one: 'Delete', other: 'Delete # items' });
  const handoffInput: HandoffDispatchInput | null = isAsset
    ? null
    : isFolder
      ? buildFolderHandoffInput({
          folderRelativePath: relativePathForTreeItem(item),
          workspace,
        })
      : buildHandoffInput({
          docName: treeFilePathToDocName(item.path),
          workspace,
        });

  const closeForInlineSurface = () => context.close({ restoreFocus: false });
  const close = () => context.close();

  const handleShowHiddenFilesToggle = (checked: boolean) => {
    if (projectLocalBinding === null) return;
    const result = projectLocalBinding.patch({
      appearance: { sidebar: { showHiddenFiles: checked } },
    });
    if (!result.ok) {
      console.warn('[FileTree] showHiddenFiles toggle rejected:', humanFormat(result.error));
      toast.error(t`Could not update sidebar settings`, {
        description: humanFormat(result.error),
      });
    }
  };
  let subtreeFolderCount = 0;
  let subtreeExpandedCount = 0;
  if (isFolder) {
    const root = folderPathToTreeDirectoryPath(item.path);
    for (const folderPath of folderTreePaths) {
      if (folderPath === root || folderPath.startsWith(root)) {
        subtreeFolderCount++;
        if (asDirectoryHandle(model.getItem(folderPath))?.isExpanded()) {
          subtreeExpandedCount++;
        }
      }
    }
  }
  const showSubtreeExpandAll = isFolder && subtreeExpandedCount < subtreeFolderCount;
  const showSubtreeCollapseAll = isFolder && subtreeExpandedCount > 0;

  return (
    <DropdownMenu
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden="true"
          data-file-tree-context-menu-root="true"
          className="block size-px"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        sideOffset={0}
        align="start"
        data-file-tree-context-menu-root="true"
        className="min-w-52"
      >
        {isFolder ? (
          <>
            <DropdownMenuItem
              disabled={anyActionBusy}
              onSelect={() => {
                closeForInlineSurface();
                onStartCreating('file', treeDirectoryPathToFolderPath(item.path));
              }}
            >
              <SquarePen aria-hidden="true" />
              <Trans>New file</Trans>
            </DropdownMenuItem>
            {folderHasTemplates ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger disabled={anyActionBusy}>
                  <FilePlus aria-hidden="true" />
                  <Trans>New from template</Trans>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <TemplateMenuRows
                    parentDir={treeDirectoryPathToFolderPath(item.path)}
                    onSelectTemplate={(templateName) => {
                      closeForInlineSurface();
                      onCreateFromTemplate(treeDirectoryPathToFolderPath(item.path), templateName);
                    }}
                    ItemComponent={DropdownMenuItem}
                  />
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : null}
            <DropdownMenuItem
              disabled={anyActionBusy}
              onSelect={() => {
                closeForInlineSurface();
                onStartCreating('folder', treeDirectoryPathToFolderPath(item.path));
              }}
            >
              <FolderPlus aria-hidden="true" />
              <Trans>New folder</Trans>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <RevealInFileManagerMenuItem item={item} workspace={workspace} onClose={close} />
            <OpenInAgentContextSubmenu
              input={handoffInput}
              installStates={handoff.installStates}
              isElectronHost={handoff.isElectronHost}
              dispatch={handoff.dispatch}
            />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Copy aria-hidden="true" />
                <Trans>Copy path</Trans>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem
                  disabled={!workspace}
                  onSelect={() => {
                    if (!workspace) return;
                    close();
                    const full = joinWorkspacePath(
                      workspace.contentDir,
                      relativePathForTreeItem(item),
                      workspace.pathSeparator,
                    );
                    void copyToClipboard(full, 'full');
                  }}
                >
                  <Trans>Full path</Trans>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    close();
                    void copyToClipboard(relativePathForTreeItem(item), 'relative');
                  }}
                >
                  <Trans>Relative path</Trans>
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            {/* Flips the persisted `showHiddenFiles` config; the client-side
                dot-segment filter reads it from a separate seam. */}
            <DropdownMenuCheckboxItem
              checked={showHiddenFiles}
              onCheckedChange={handleShowHiddenFilesToggle}
              disabled={!canToggleVisibility}
              data-testid="file-tree-menu-show-hidden-files"
            >
              <Trans>Show hidden files</Trans>
            </DropdownMenuCheckboxItem>
            {/* Subtree-scoped Expand/Collapse, smart-hidden. The divider only
                renders when the section is non-empty so a fully-expanded or
                fully-collapsed subtree collapses to a single divider before
                the destructive section instead of an empty double rule. */}
            {showSubtreeExpandAll || showSubtreeCollapseAll ? <DropdownMenuSeparator /> : null}
            {showSubtreeExpandAll ? (
              <DropdownMenuItem
                onSelect={() => {
                  close();
                  onExpandSubtree(item.path);
                }}
              >
                <UnfoldVertical aria-hidden="true" />
                <Trans>Expand all</Trans>
              </DropdownMenuItem>
            ) : null}
            {showSubtreeCollapseAll ? (
              <DropdownMenuItem
                onSelect={() => {
                  close();
                  onCollapseSubtree(item.path);
                }}
              >
                <FoldVertical aria-hidden="true" />
                <Trans>Collapse all</Trans>
              </DropdownMenuItem>
            ) : null}
            {/* Destructive section. Rename sits with Hide/Delete here (not at
                the top with creation) so the menu's read order is
                create → act → filter → tree → mutate-or-remove. */}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={anyActionBusy}
              onSelect={() => {
                if (target.kind === 'asset') return;
                close();
                onDuplicate(target);
              }}
            >
              <CopyPlus aria-hidden="true" />
              <Trans>Duplicate</Trans>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={anyActionBusy}
              onSelect={() => {
                closeForInlineSurface();
                model.startRenaming(item.path);
              }}
            >
              <Pencil aria-hidden="true" />
              <Trans>Rename</Trans>
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid="file-tree-menu-hide"
              disabled={!canHide}
              onSelect={() => {
                if (!okignoreBinding || !okignoreTarget) return;
                close();
                const pattern = buildOkignorePatternFromTarget(okignoreTarget);
                const current = okignoreBinding.current();
                const doc = parseOkignoreDoc(current);
                const updated = appendPattern(doc, pattern);
                if (updated === doc) return;
                okignoreBinding.patch(serializeOkignoreDoc(updated));
                const basename = okignoreTarget.path.split('/').pop() || okignoreTarget.path;
                toast.success(t`Hidden folder “${basename}”`, {
                  description: t`Manage hidden files in Settings → Ignore patterns.`,
                  duration: 5000,
                });
              }}
            >
              <EyeOff aria-hidden="true" />
              {hideLabel}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              disabled={anyActionBusy}
              onSelect={() => {
                close();
                onDelete(deleteTargets);
              }}
            >
              <Trash2 aria-hidden="true" />
              {deleteLabel}
            </DropdownMenuItem>
          </>
        ) : (
          <>
            <RevealInFileManagerMenuItem item={item} workspace={workspace} onClose={close} />
            {!isAsset && (
              <OpenInAgentContextSubmenu
                input={handoffInput}
                installStates={handoff.installStates}
                isElectronHost={handoff.isElectronHost}
                dispatch={handoff.dispatch}
              />
            )}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Copy aria-hidden="true" />
                <Trans>Copy path</Trans>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem
                  disabled={!workspace}
                  onSelect={() => {
                    if (!workspace) return;
                    close();
                    const full = joinWorkspacePath(
                      workspace.contentDir,
                      relativePathForTreeItem(item),
                      workspace.pathSeparator,
                    );
                    void copyToClipboard(full, 'full');
                  }}
                >
                  <Trans>Full path</Trans>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    close();
                    void copyToClipboard(relativePathForTreeItem(item), 'relative');
                  }}
                >
                  <Trans>Relative path</Trans>
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            {!isAsset ? (
              <DropdownMenuItem
                disabled={anyActionBusy}
                onSelect={() => {
                  close();
                  onDuplicate(target);
                }}
              >
                <CopyPlus aria-hidden="true" />
                <Trans>Duplicate</Trans>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              disabled={anyActionBusy}
              onSelect={() => {
                closeForInlineSurface();
                model.startRenaming(item.path);
              }}
            >
              <Pencil aria-hidden="true" />
              <Trans>Rename</Trans>
            </DropdownMenuItem>
            {okignoreTarget ? (
              <DropdownMenuItem
                data-testid="file-tree-menu-hide"
                disabled={!canHide}
                onSelect={() => {
                  if (!okignoreBinding) return;
                  close();
                  const pattern = buildOkignorePatternFromTarget(okignoreTarget);
                  const current = okignoreBinding.current();
                  const doc = parseOkignoreDoc(current);
                  const updated = appendPattern(doc, pattern);
                  if (updated === doc) return;
                  okignoreBinding.patch(serializeOkignoreDoc(updated));
                  const basename = okignoreTarget.path.split('/').pop() || okignoreTarget.path;
                  toast.success(t`Hidden “${basename}”`, {
                    description: t`Manage hidden files in Settings → Ignore patterns.`,
                    duration: 5000,
                  });
                }}
              >
                <EyeOff aria-hidden="true" />
                {hideLabel}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              variant="destructive"
              disabled={anyActionBusy}
              onSelect={() => {
                close();
                onDelete(deleteTargets);
              }}
            >
              <Trash2 aria-hidden="true" />
              {deleteLabel}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface FileTreeHandle {
  startCreating(kind: 'file' | 'folder', parentDir: string): void;
  /** Open NewItemDialog at the given parentDir so the template picker is
   *  reachable. Used by the native macOS File menu's "New from Template…"
   *  item, where an inline hover-submenu of templates isn't expressible. */
  startCreatingFromTemplate(parentDir: string): void;
  /** Inline create-from-template: same fast path as `startCreating('file', …)`
   *  (placeholder + inline rename) but seeds the doc from the named template.
   *  Drives the in-renderer "New from template" submenus. */
  createFromTemplate(parentDir: string, templateName: string): void;
  expandAll(): void;
  collapseAll(): void;
  getFolderState(): { folderCount: number; expandedCount: number };
  isCreationTargetCleared(): boolean;
  clearCreationTarget(): void;
  subscribe(listener: () => void): () => void;
}

type ShowAllDepth1ListingResult =
  | { kind: 'entries'; entries: FileEntry[]; truncated: boolean }
  | { kind: 'http-error'; title: string }
  | { kind: 'network-error'; cause: unknown };

async function fetchShowAllDepth1Listing(
  dir: string,
  signal: AbortSignal,
  fallbackErrorTitle: string,
  schemaMismatchTitle: string,
): Promise<ShowAllDepth1ListingResult> {
  try {
    const res = await fetch(`/api/documents?showAll=true&dir=${encodeURIComponent(dir)}&depth=1`, {
      signal,
      headers: SHOW_ALL_NDJSON_ACCEPT,
    });
    if (isNdjsonResponse(res)) {
      const consumed = await consumeShowAllStream(res);
      return {
        kind: 'entries',
        entries: toFileEntries(consumed.entries),
        truncated: consumed.truncated,
      };
    }
    const parsed = await parseServerResponse(res, fallbackErrorTitle);
    if (!parsed.ok) return { kind: 'http-error', title: parsed.title };
    const success = DocumentListSuccessSchema.safeParse(parsed.body);
    if (!success.success) return { kind: 'http-error', title: schemaMismatchTitle };
    return {
      kind: 'entries',
      entries: toFileEntries(success.data.documents),
      truncated: success.data.truncated === true,
    };
  } catch (cause) {
    if (cause instanceof ShowAllStreamError) {
      return { kind: 'http-error', title: cause.message };
    }
    return { kind: 'network-error', cause };
  }
}

export function FileTree({
  ref,
  onContentHeightChange,
}: {
  ref?: Ref<FileTreeHandle | null>;
  onContentHeightChange?: (px: number) => void;
}) {
  const { t, i18n } = useLingui();
  const {
    activeDocName,
    activeTarget,
    closeTabs,
    closeDocument,
    closeAndClearForRename,
    getPoolActiveDocName,
    poolHas,
    isNewTabActive,
    openTarget,
    prewarm,
    remapTabsForRename,
  } = useDocumentContext();
  const { notifySidebarFileSelected } = useSidebar();
  const { resolvedTheme } = useTheme();
  const { addPage, pageMeta } = usePageList();
  function navigationTargetForDocument(
    docName: string,
    size: number | null | undefined,
  ): ResolvedNavigationTarget {
    return (
      largeFileNavigationTarget(docName, size ?? pageMeta.get(docName)?.size) ?? {
        kind: 'doc',
        target: docName,
        docName,
      }
    );
  }
  function navigateToWithPulse(targetPath: string, size?: number) {
    openTarget(navigationTargetForDocument(targetPath, size), { tabBehavior: 'replace-active' });
    replaceHashWithoutNavigation(hashFromDocName(targetPath));
    notifySidebarFileSelected();
  }
  function navigateToFolderWithPulse(folderPath: string) {
    const nextHash = hashFromFolderPath(folderPath);
    openTarget(
      { kind: 'folder', target: folderPath, folderPath },
      { tabBehavior: 'replace-active' },
    );
    replaceHashWithoutNavigation(nextHash);
    notifySidebarFileSelected();
  }
  const [documents, setDocuments] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const relaunchInFlight = useRelaunchInFlight();
  const connectivityRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [truncatedShownCount, setTruncatedShownCount] = useState<number | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [deleteRequest, setDeleteRequest] = useState<FileTreeDeleteRequest | null>(null);
  const [trashFailure, setTrashFailure] = useState<TrashFailureRequest | null>(null);
  const { conflicts: activeConflicts } = useConflicts();
  const [newItemRequest, setNewItemRequest] = useState<{ parentDir: string } | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [creationDirCleared, setCreationDirCleared] = useState(false);
  const creationDirClearedRef = useRef(creationDirCleared);
  const handleListenersRef = useRef<Set<() => void>>(new Set());

  const documentsRef = useRef(documents);
  const pageMetaRef = useRef(pageMeta);
  function activateTreePath(treePath: string, entries: readonly FileEntry[] = documents) {
    const action = resolveFileTreeSelectionAction(treePath, entries);
    if (action.kind === 'none') {
      console.debug(
        '[FileTree] Dropped selection for unknown docName:',
        treePathToAppPath(treePath),
      );
      return;
    }
    if (action.kind === 'asset') {
      openTarget(
        {
          kind: 'asset',
          target: action.path,
          assetPath: action.path,
          mediaKind: action.mediaKind,
        },
        { tabBehavior: 'replace-active' },
      );
      replaceHashWithoutNavigation(action.hash);
      notifySidebarFileSelected();
      return;
    }
    if (action.kind === 'folder') {
      navigateToFolderWithPulse(action.path);
      return;
    }
    const docEntry = entries.find(
      (item): item is DocumentEntry => isDocumentEntry(item) && item.docName === action.path,
    );
    navigateToWithPulse(action.path, docEntry?.size);
  }
  function navigateToAssetWithPulse(assetPath: string, entries?: readonly FileEntry[]) {
    const currentEntries = entries ?? documentsRef.current;
    const entry = currentEntries.find(
      (item): item is Extract<FileEntry, { kind: 'asset' }> =>
        isAssetEntry(item) && item.path === assetPath,
    );
    openTarget(
      {
        kind: 'asset',
        target: assetPath,
        assetPath,
        mediaKind: entry?.mediaKind ?? null,
      },
      { tabBehavior: 'replace-active' },
    );
    replaceHashWithoutNavigation(hashFromAssetPath(assetPath));
    notifySidebarFileSelected();
  }
  const activeDocNameRef = useRef(activeDocName);
  const assetTreePaths = new Set(
    documents.filter(isAssetEntry).map((entry) => fileEntryToTreePath(entry)),
  );
  const assetTreePathsRef = useRef(assetTreePaths);
  const activeAncestorTreePathsRef = useRef<string[]>([]);
  const pendingCreateRef = useRef<PendingCreate | null>(null);
  const cleanupPendingCreateRef = useRef<
    (pending: PendingCreate, options?: PendingCreateCleanupOptions) => Promise<void>
  >(async () => {});
  const skipNextResetSignatureRef = useRef<string | null>(null);
  const hoveredPrewarmDocRef = useRef<string | null>(null);
  const suppressSelectionRef = useRef(false);
  const sidebarDragInProgressRef = useRef(false);
  const sidebarDragClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const externalFileDropTargetRef = useRef<{ row: HTMLElement | null; root: HTMLElement | null }>({
    row: null,
    root: null,
  });
  const uploadExternalFilesRef = useRef<
    (files: readonly File[], parentDir: string, busyPath: string) => void
  >(() => {});
  const busyPathRef = useRef<string | null>(null);
  const recentLocalAddsRef = useRef<Map<string, number>>(new Map());
  const lazyLoadedDirTreePathsRef = useRef<Set<string>>(new Set());
  const lazyChildFetchControllersRef = useRef<Map<string, AbortController>>(new Map());
  const lazyChildFetchGenerationRef = useRef(0);
  const prevExpandedFolderTreePathsRef = useRef<ReadonlySet<string>>(new Set());
  const detectLazyFolderExpansionsRef = useRef<() => void>(() => {});
  const revalidateExpandedLazyDirsRef = useRef<() => void>(() => {});
  const showHiddenFilesRef = useRef<boolean>(false);
  const refreshDocsScheduleRef = useRef<(() => void) | null>(null);
  const fileTreeHostRef = useRef<HTMLDivElement | null>(null);
  const handleSelectionChangeRef = useRef<(selectedPaths: readonly string[]) => void>(() => {});
  const handleRenameRef = useRef<(event: FileTreeRenameEvent) => void>(() => {});
  const handleRenameErrorRef = useRef<(message: string) => void>((message) => toast.error(message));
  const handleDropCompleteRef = useRef<(event: FileTreeDropResult) => void>(() => {});
  const activeTargetRef = useRef(activeTarget);
  const [emptyExternalFileDropActive, setEmptyExternalFileDropActive] = useState(false);

  function clearConnectivityRetry() {
    if (connectivityRetryTimerRef.current !== null) {
      clearTimeout(connectivityRetryTimerRef.current);
      connectivityRetryTimerRef.current = null;
    }
  }
  function noteConnectivityRecovered() {
    clearConnectivityRetry();
    setReconnecting(false);
  }
  function reportServerReachableError(title: string) {
    noteConnectivityRecovered();
    setError(title);
  }
  function reportConnectivityFailure() {
    clearConnectivityRetry();
    if (getRelaunchInFlightSnapshot()) {
      setError(null);
      setReconnecting(true);
      connectivityRetryTimerRef.current = setTimeout(() => {
        connectivityRetryTimerRef.current = null;
        refreshDocsScheduleRef.current?.();
      }, CONNECTIVITY_RECONNECT_RETRY_MS);
      return;
    }
    setReconnecting(false);
    setError(t`Could not reach server`);
  }

  const isFirstRelaunchEffectRunRef = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: relaunchInFlight is a transition trigger, not a read — the body calls the hoisted scheduler ref only. Sibling pattern at the showHiddenFiles flip effect below.
  useEffect(() => {
    if (isFirstRelaunchEffectRunRef.current) {
      isFirstRelaunchEffectRunRef.current = false;
      return;
    }
    refreshDocsScheduleRef.current?.();
  }, [relaunchInFlight]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount/unmount-only; see comment above.
  useEffect(() => clearConnectivityRetry, []);

  useEffect(() => {
    if (loading || documents.length === 0) return;
    const shadow = fileTreeHostRef.current?.querySelector(FILE_TREE_TAG_NAME)?.shadowRoot;
    if (!shadow) return;
    const shadowRoot = shadow;

    function clearSidebarDragInProgressSoon() {
      if (sidebarDragClearTimerRef.current !== null) {
        clearTimeout(sidebarDragClearTimerRef.current);
      }
      sidebarDragClearTimerRef.current = setTimeout(() => {
        sidebarDragInProgressRef.current = false;
        sidebarDragClearTimerRef.current = null;
      }, 0);
    }

    function handleDragStart(event: Event) {
      if (!(event instanceof DragEvent)) return;
      const item = findTreeItemElement(event);
      const rawPath = item?.dataset.itemPath;
      if (!rawPath) return;

      const treePath =
        item.dataset.itemType === 'folder' ? folderPathToTreeDirectoryPath(rawPath) : rawPath;
      const payload = sidebarDragPayloadForTreePath(
        treePath,
        documentsRef.current,
        pageMetaRef.current,
      );
      if (!payload) return;

      if (sidebarDragClearTimerRef.current !== null) {
        clearTimeout(sidebarDragClearTimerRef.current);
        sidebarDragClearTimerRef.current = null;
      }
      sidebarDragInProgressRef.current = true;
      event.dataTransfer?.setData(OK_SIDEBAR_DRAG_MIME, serializeSidebarDragPayload(payload));
    }

    function handleExternalFileDragOver(event: Event) {
      if (!(event instanceof DragEvent)) return;
      if (!isExternalFileDrag(event)) return;
      const target = resolveExternalFileDropTarget(event);
      if (!target) {
        clearExternalFileDropAffordance(externalFileDropTargetRef);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      setExternalFileDropAffordance(externalFileDropTargetRef, target);
    }

    function handleExternalFileDragLeave(event: Event) {
      if (!(event instanceof DragEvent)) return;
      if (!isExternalFileDrag(event)) return;
      const related = event.relatedTarget;
      if (related instanceof Node && shadowRoot.contains(related)) return;
      clearExternalFileDropAffordance(externalFileDropTargetRef);
    }

    function handleExternalFileDrop(event: Event) {
      if (!(event instanceof DragEvent)) return;
      if (!isExternalFileDrag(event)) return;
      const target = resolveExternalFileDropTarget(event);
      const files = filesFromExternalDrop(event);
      if (!target || files.length === 0) {
        clearExternalFileDropAffordance(externalFileDropTargetRef);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      clearExternalFileDropAffordance(externalFileDropTargetRef);
      uploadExternalFilesRef.current(files, target.parentDir, target.busyPath);
    }

    shadow.addEventListener('dragstart', handleDragStart, { capture: true });
    shadow.addEventListener('dragover', handleExternalFileDragOver, { capture: true });
    shadow.addEventListener('dragleave', handleExternalFileDragLeave, { capture: true });
    shadow.addEventListener('drop', handleExternalFileDrop, { capture: true });
    shadow.addEventListener('dragend', clearSidebarDragInProgressSoon, { capture: true });
    window.addEventListener('drop', clearSidebarDragInProgressSoon, true);
    window.addEventListener('dragend', clearSidebarDragInProgressSoon, true);
    return () => {
      shadow.removeEventListener('dragstart', handleDragStart, { capture: true });
      shadow.removeEventListener('dragover', handleExternalFileDragOver, { capture: true });
      shadow.removeEventListener('dragleave', handleExternalFileDragLeave, { capture: true });
      shadow.removeEventListener('drop', handleExternalFileDrop, { capture: true });
      shadow.removeEventListener('dragend', clearSidebarDragInProgressSoon, { capture: true });
      window.removeEventListener('drop', clearSidebarDragInProgressSoon, true);
      window.removeEventListener('dragend', clearSidebarDragInProgressSoon, true);
      clearExternalFileDropAffordance(externalFileDropTargetRef);
      if (sidebarDragClearTimerRef.current !== null) {
        clearTimeout(sidebarDragClearTimerRef.current);
        sidebarDragClearTimerRef.current = null;
      }
      sidebarDragInProgressRef.current = false;
    };
  }, [documents.length, loading]);

  const {
    selectedFilePath,
    selectedFolderPath,
    navigationPath: activeNavigationPath,
  } = resolveFileTreeSelection(activeTarget, isNewTabActive ? null : activeDocName);
  const baseActiveTreePath = selectedFilePath
    ? docNameToTreePath(
        selectedFilePath,
        documents.find(
          (d): d is DocumentEntry => isDocumentEntry(d) && d.docName === selectedFilePath,
        )?.docExt,
      )
    : selectedFolderPath
      ? folderPathToTreeDirectoryPath(selectedFolderPath)
      : activeTarget?.kind === 'asset'
        ? activeTarget.assetPath
        : null;
  const activeTreePath = creationDirCleared ? null : baseActiveTreePath;

  const handoffInstallStates = useInstalledAgents().states;
  const { dispatch: dispatchHandoff } = useHandoffDispatch();
  const handoff = {
    installStates: handoffInstallStates,
    isElectronHost: typeof window !== 'undefined' && window.okDesktop != null,
    dispatch: dispatchHandoff,
  };
  const { okignoreBinding, projectLocalBinding, merged } = useConfigContext();
  const showHiddenFiles = merged?.appearance?.sidebar?.showHiddenFiles ?? false;

  const isAvailable = () => busyPathRef.current === null;

  const { model } = useFileTree({
    paths: [],
    initialExpansion: 'closed',
    fileTreeSearchMode: 'hide-non-matches',
    initialVisibleRowCount: 18,
    stickyFolders: true,
    ...FILE_TREE_DENSITY_OPTIONS,
    icons: {
      set: 'complete',
      spriteSheet: FILE_TREE_DECORATION_SPRITE_SHEET,
      byFileExtension: {
        md: { name: MARKDOWN_FILE_ICON_ID, viewBox: MARKDOWN_FILE_ICON_VIEWBOX },
        mdx: { name: MARKDOWN_FILE_ICON_ID, viewBox: MARKDOWN_FILE_ICON_VIEWBOX },
      },
    },
    unsafeCSS: FILE_TREE_UNSAFE_CSS,
    composition: {
      contextMenu: {
        enabled: true,
        triggerMode: 'both',
        buttonVisibility: 'when-needed',
      },
    },
    dragAndDrop: {
      canDrag: isAvailable,
      canDrop: isAvailable,
      onDropComplete: (event) => handleDropCompleteRef.current(event),
      onDropError: (message) => {
        toast.error(message);
      },
    },
    renaming: {
      canRename: isAvailable,
      onRename: (event) => handleRenameRef.current(event),
      onError: (message) => handleRenameErrorRef.current(message),
    },
    onSelectionChange: (selectedPaths) => handleSelectionChangeRef.current(selectedPaths),
    renderRowDecoration: ({ item }) => {
      if (item.kind === 'file') {
        const doc = documentsRef.current.find(
          (entry): entry is DocumentEntry =>
            isDocumentEntry(entry) && docNameToTreePath(entry.docName, entry.docExt) === item.path,
        );
        if (doc?.isSymlink) {
          const targetPath = doc.targetPath;
          return {
            icon: LINK_DECORATION_ICON_ID,
            title: targetPath ? t`Symlink to ${targetPath}` : t`Symlink`,
          };
        }
        if (isAgentTreePath(item.path)) {
          return {
            icon: AGENT_DECORATION_ICON_ID,
            title: t`Agent configuration file`,
          };
        }
        return null;
      }
      const folder = documentsRef.current.find(
        (entry): entry is FolderEntry =>
          isFolderEntry(entry) &&
          folderPathToTreeDirectoryPath(entry.path) === folderPathToTreeDirectoryPath(item.path),
      );
      if (folder?.isSymlink) {
        const targetPath = folder.targetPath;
        return {
          icon: LINK_DECORATION_ICON_ID,
          title: targetPath ? t`Symlink to ${targetPath}` : t`Symlink`,
        };
      }
      return null;
    },
  });

  function normalizeSelectionPath(treePath: string): string {
    const item = model.getItem(treePath) ?? model.getItem(folderPathToTreeDirectoryPath(treePath));
    if (item?.isDirectory()) {
      return folderPathToTreeDirectoryPath(treeDirectoryPathToFolderPath(item.getPath()));
    }
    return treePath;
  }

  const treePaths = documentsToTreePaths(documents);
  const treePathsSignature = treePathSignature(treePaths);
  const treePathsRef = useRef(treePaths);
  const folderTreePaths = collectTreeFolderPathsFromDocuments(documents);
  const folderTreePathsRef = useRef(folderTreePaths);

  const activeAncestorTreePaths = selectedFolderPath
    ? computeTreeAncestorPaths(folderPathToTreeDirectoryPath(selectedFolderPath)).slice(0, -1)
    : computeTreeAncestorPaths(activeTreePath ?? activeNavigationPath);
  const activeAncestorTreePathsSignature = activeAncestorTreePaths.join('\0');

  const collectExpandedFolderTreePaths = () => {
    const expanded = new Set<string>();
    for (const folderPath of folderTreePathsRef.current) {
      const item = asDirectoryHandle(model.getItem(folderPath));
      if (item?.isExpanded()) {
        expanded.add(folderPath);
      }
    }
    return expanded;
  };

  const expandedPathsForReset = (nextDocuments?: readonly FileEntry[]) => {
    const nextFolderPaths = new Set(
      collectTreeFolderPathsFromDocuments(nextDocuments ?? documentsRef.current),
    );
    const expanded = collectExpandedFolderTreePaths();
    for (const ancestor of activeAncestorTreePathsRef.current) {
      expanded.add(ancestor);
    }
    return [...expanded].filter((path) => nextFolderPaths.has(path));
  };

  const resetModelToDocuments = (nextDocuments?: readonly FileEntry[]) => {
    const nextPaths = documentsToTreePaths(nextDocuments ?? documentsRef.current);
    model.resetPaths(nextPaths, {
      initialExpandedPaths: expandedPathsForReset(nextDocuments),
    });
  };

  async function fetchLazyFolderChildren(folderTreePath: string) {
    const generation = lazyChildFetchGenerationRef.current;
    const controller = new AbortController();
    lazyChildFetchControllersRef.current.set(folderTreePath, controller);
    const result = await fetchShowAllDepth1Listing(
      treeDirectoryPathToFolderPath(folderTreePath),
      controller.signal,
      t`Failed to load documents`,
      t`Documents response did not match expected shape.`,
    );
    if (lazyChildFetchControllersRef.current.get(folderTreePath) === controller) {
      lazyChildFetchControllersRef.current.delete(folderTreePath);
    }
    if (controller.signal.aborted || generation !== lazyChildFetchGenerationRef.current) return;
    if (result.kind === 'network-error') {
      reportConnectivityFailure();
      console.warn('[FileTree] lazy folder children fetch failed:', folderTreePath, result.cause);
      return;
    }
    if (result.kind === 'http-error') {
      console.warn('[FileTree] lazy folder children http error:', folderTreePath, result.title);
      reportServerReachableError(result.title);
      return;
    }
    const bypassClientDotDrop = showHiddenFilesRef.current;
    const children = filterVisibleEntries(result.entries, bypassClientDotDrop);
    lazyLoadedDirTreePathsRef.current.add(folderTreePath);
    setDocuments((prev) =>
      spliceLazyFolderChildren(prev, folderTreePath, children, recentLocalAddsRef.current),
    );
    setError(null);
    noteConnectivityRecovered();
    if (result.truncated) setTruncatedShownCount(result.entries.length);
  }

  const detectLazyFolderExpansions = () => {
    const expanded = collectExpandedFolderTreePaths();
    const previous = prevExpandedFolderTreePathsRef.current;
    prevExpandedFolderTreePathsRef.current = expanded;
    for (const folderTreePath of expanded) {
      if (previous.has(folderTreePath)) continue;
      if (lazyLoadedDirTreePathsRef.current.has(folderTreePath)) continue;
      if (lazyChildFetchControllersRef.current.has(folderTreePath)) continue;
      const folderPath = treeDirectoryPathToFolderPath(folderTreePath);
      const entry = documentsRef.current.find(
        (candidate): candidate is Extract<FileEntry, { kind: 'folder' }> =>
          isFolderEntry(candidate) && candidate.path === folderPath,
      );
      if (entry?.hasChildren === false) continue;
      void fetchLazyFolderChildren(folderTreePath);
    }
  };

  const revalidateExpandedLazyDirs = () => {
    for (const folderTreePath of collectExpandedFolderTreePaths()) {
      if (lazyLoadedDirTreePathsRef.current.has(folderTreePath)) continue;
      if (lazyChildFetchControllersRef.current.has(folderTreePath)) continue;
      void fetchLazyFolderChildren(folderTreePath);
    }
  };

  const reconcileModelAfterExtensionlessRename = (
    current: readonly FileEntry[],
    next: readonly FileEntry[],
    renamed: readonly RenamedDocMapping[],
    renamedAssets: readonly RenamedAssetMapping[] = [],
  ): void => {
    let reconciledCount = 0;
    let lastCanonical: string | null = null;
    for (const { fromDocName, toDocName } of renamed) {
      const source = current.find(
        (entry): entry is DocumentEntry => isDocumentEntry(entry) && entry.docName === fromDocName,
      );
      if (source == null) continue;
      if (model.getItem(toDocName) == null) continue;
      const destination = next.find(
        (entry): entry is DocumentEntry => isDocumentEntry(entry) && entry.docName === toDocName,
      );
      const canonicalTreePath = docNameToTreePath(toDocName, destination?.docExt ?? source.docExt);
      model.move(toDocName, canonicalTreePath);
      lastCanonical = canonicalTreePath;
      reconciledCount += 1;
    }
    for (const { toPath } of renamedAssets) {
      const ext = getFileExtension(toPath);
      if (ext === '') continue;
      const extensionlessTreePath = toPath.slice(0, -ext.length);
      if (model.getItem(extensionlessTreePath) == null) continue;
      if (model.getItem(toPath) == null) {
        model.move(extensionlessTreePath, toPath);
      }
      lastCanonical = toPath;
      reconciledCount += 1;
    }
    if (reconciledCount === 0) return;
    resetModelToDocuments(next);
    if (lastCanonical != null) {
      model.focusPath(lastCanonical);
    }
  };

  const markNextDocumentsAsApplied = (nextDocuments: readonly FileEntry[]) => {
    skipNextResetSignatureRef.current = documentsTreePathSignature(nextDocuments);
  };

  const isAssetTreePath = (treePath: string) => assetTreePathsRef.current.has(treePath);

  async function handleDuplicateTarget(target: FileTreeTarget) {
    if (target.kind === 'asset') return;
    if (busyPathRef.current !== null) return;
    const clearBusyState = () => {
      setBusyPath(null);
      busyPathRef.current = null;
    };
    busyPathRef.current = target.path;
    setBusyPath(target.path);
    setError(null);

    try {
      const res = await fetch('/api/duplicate-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: target.kind, path: target.path }),
      });
      const parsed = await parseServerResponse(res, t`Failed to duplicate path`);

      if (!parsed.ok) {
        toast.error(parsed.title);
        resetModelToDocuments();
        clearBusyState();
        return;
      }

      const success = parseSuccessOrWarn(
        DuplicatePathSuccessSchema,
        parsed.body,
        'duplicate-path',
        null,
      );
      if (success === null) {
        const message = t`Duplicate succeeded but the sidebar may be out of date — refresh to resync`;
        toast.error(message);
        setError(message);
        emitDocumentsChanged(['files', 'backlinks', 'graph']);
        resetModelToDocuments();
        clearBusyState();
        return;
      }

      for (const docName of success.duplicatedDocNames) {
        addPage(docName);
      }
      setDocuments((current) => {
        const next = applyDuplicateToDocuments(current, target, success);
        resetModelToDocuments(next);
        markNextDocumentsAsApplied(next);
        return next;
      });
      emitDocumentsChanged(['files', 'backlinks', 'graph']);

      if (success.path !== target.path) {
        if (success.kind === 'folder') {
          navigateToFolderWithPulse(success.path);
        } else {
          navigateToWithPulse(success.path);
        }
      }
      toast.success(success.kind === 'folder' ? t`Folder duplicated` : t`File duplicated`, {
        description: success.path,
      });
      clearBusyState();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn('[FileTree] duplicate failed:', err);
      toast.error(t`Could not duplicate item`, { description: detail });
      resetModelToDocuments();
      clearBusyState();
    }
  }

  const handleDuplicateTargetRef = useRef(handleDuplicateTarget);
  useEffect(() => {
    handleDuplicateTargetRef.current = handleDuplicateTarget;
  });

  function recoverMarkdownRenameConflict(message: string): boolean {
    const bareDestinationPath = parseAlreadyExistsRenamePath(message);
    if (!bareDestinationPath || markdownTreeExtension(bareDestinationPath)) return false;

    const sourceTreePath = model.getFocusedPath() ?? model.getSelectedPaths()[0] ?? null;
    if (!sourceTreePath || sourceTreePath.endsWith('/') || isAssetTreePath(sourceTreePath)) {
      return false;
    }

    const sourceExtension = markdownTreeExtension(sourceTreePath);
    if (!sourceExtension) return false;

    const folderTreePath = folderPathToTreeDirectoryPath(bareDestinationPath);
    if (!folderTreePathsRef.current.includes(folderTreePath)) return false;

    const destinationTreePath = `${bareDestinationPath}${sourceExtension}`;
    if (treePathsRef.current.includes(destinationTreePath)) return false;

    const event = {
      sourcePath: sourceTreePath,
      destinationPath: destinationTreePath,
      isFolder: false,
    } satisfies FileTreeRenameEvent;

    void handleTreeRename(event);
    model.move(sourceTreePath, destinationTreePath);
    return true;
  }

  const clearPendingCreate = (pending?: PendingCreate | null) => {
    const current = pending ?? pendingCreateRef.current;
    if (!current || pendingCreateRef.current !== current) return;
    current.disposeCommitListener();
    pendingCreateRef.current = null;
  };

  async function cleanupPendingCreate(
    pending: PendingCreate,
    options: PendingCreateCleanupOptions = {},
  ) {
    const updateUi = options.updateUi ?? true;
    const restoreLocation = options.restoreLocation ?? updateUi;

    clearPendingCreate(pending);
    if (updateUi) setBusyPath(pending.renamePath);

    try {
      const res = await fetch('/api/delete-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: pending.kind, path: pending.createdPath }),
      });
      if (!res.ok && res.status !== 404) {
        const kind = pending.kind;
        const createdPath = pending.createdPath;
        const parsed = await parseServerResponse(res, t`Failed to clean up pending ${kind}`);
        if (parsed.ok) return;
        const detail = parsed.title;
        const message = t`${detail} - ${kind} "${createdPath}" still exists on disk`;
        if (updateUi) {
          toast.error(message);
        } else {
          console.warn(`[FileTree] cleanup pending create failed: ${message}`);
        }
        if (updateUi) {
          setBusyPath(null);
          resetModelToDocuments();
        }
        return;
      }
    } catch (err) {
      console.warn('[FileTree] cleanup pending create failed:', err);
      if (updateUi) {
        const kind = pending.kind;
        const createdPath = pending.createdPath;
        toast.error(t`Network error - ${kind} "${createdPath}" still exists on disk`);
      }
      if (updateUi) {
        setBusyPath(null);
        resetModelToDocuments();
      }
      return;
    }

    if (updateUi) {
      if (pending.kind === 'file') {
        closeDocument(pending.createdPath);
      } else {
        closeTabs([folderTabId(pending.createdPath)], { force: true });
      }
    }
    if (updateUi) {
      setDocuments((current) => {
        const next = applyDeleteToDocuments(
          current,
          pending.kind === 'file' ? [pending.createdPath] : [],
          pending.kind === 'folder' ? pending.createdPath : undefined,
        );
        markNextDocumentsAsApplied(next);
        return next;
      });
    }
    emitDocumentsChanged(['files', 'backlinks', 'graph']);
    if (restoreLocation) window.location.hash = pending.previousHash;
    if (updateUi) setBusyPath(null);
  }

  useEffect(() => {
    return () => {
      const pending = pendingCreateRef.current;
      if (pending) {
        void cleanupPendingCreateRef
          .current(pending, {
            restoreLocation: false,
            updateUi: false,
          })
          .catch((err) => {
            console.warn('[FileTree] unmount cleanup failed:', err);
          });
      }
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: this is a once-per-`t` mount-lifecycle setup (it wires the refresh scheduler + listeners). The connectivity helpers it calls (reportConnectivityFailure / noteConnectivityRecovered) only touch refs + stable setters and close over the same `t` already in deps, so listing them would re-create the scheduler every render for no behavioral gain.
  useEffect(() => {
    let active = true;
    let refreshController: AbortController | null = null;

    async function refreshDocs() {
      refreshController?.abort();
      const controller = new AbortController();
      refreshController = controller;
      lazyChildFetchGenerationRef.current += 1;
      for (const childController of lazyChildFetchControllersRef.current.values()) {
        childController.abort();
      }
      lazyChildFetchControllersRef.current.clear();
      lazyLoadedDirTreePathsRef.current.clear();
      try {
        const res = await fetch('/api/documents?showAll=true&dir=&depth=1', {
          signal: controller.signal,
          headers: SHOW_ALL_NDJSON_ACCEPT,
        });
        if (isNdjsonResponse(res)) {
          const { entries, truncated } = await consumeShowAllStream(res);
          if (!active) return;
          const bypassClientDotDrop = showHiddenFilesRef.current;
          const serverEntries = filterVisibleEntries(toFileEntries(entries), bypassClientDotDrop);
          setDocuments((prev) =>
            spliceLazyFolderChildren(prev, '', serverEntries, recentLocalAddsRef.current),
          );
          setError(null);
          noteConnectivityRecovered();
          setTruncatedShownCount(truncated ? entries.length : null);
          revalidateExpandedLazyDirsRef.current();
        } else {
          const parsed = await parseServerResponse(res, t`Failed to load documents`);
          if (!active) return;
          if (!parsed.ok) {
            reportServerReachableError(parsed.title);
            setTruncatedShownCount(null);
          } else {
            const success = DocumentListSuccessSchema.safeParse(parsed.body);
            if (!success.success) {
              reportServerReachableError(t`Documents response did not match expected shape.`);
              setTruncatedShownCount(null);
            } else {
              const bypassClientDotDrop = showHiddenFilesRef.current;
              const serverEntries = filterVisibleEntries(
                toFileEntries(success.data.documents),
                bypassClientDotDrop,
              );
              setDocuments((prev) =>
                spliceLazyFolderChildren(prev, '', serverEntries, recentLocalAddsRef.current),
              );
              setError(null);
              noteConnectivityRecovered();
              setTruncatedShownCount(
                success.data.truncated === true ? success.data.documents.length : null,
              );
              revalidateExpandedLazyDirsRef.current();
            }
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        if (active) {
          if (err instanceof ShowAllStreamError) {
            reportServerReachableError(err.message);
          } else {
            reportConnectivityFailure();
          }
        }
        console.warn('[FileTree] fetch failed:', err);
      }
      if (active) setLoading(false);
    }

    const scheduler = createRefreshScheduler(refreshDocs, () => refreshController?.abort());
    refreshDocsScheduleRef.current = () => scheduler.request();
    scheduler.request();
    const handleResume = () => {
      if (document.visibilityState === 'visible') {
        scheduler.request();
      }
    };
    window.addEventListener('focus', handleResume);
    window.addEventListener('visibilitychange', handleResume);
    const unsubscribe = subscribeToDocumentsChanged((channels) => {
      if (channels.includes('files')) {
        scheduler.request();
      }
    });
    return () => {
      active = false;
      refreshDocsScheduleRef.current = null;
      scheduler.dispose();
      for (const childController of lazyChildFetchControllersRef.current.values()) {
        childController.abort();
      }
      lazyChildFetchControllersRef.current.clear();
      window.removeEventListener('focus', handleResume);
      window.removeEventListener('visibilitychange', handleResume);
      unsubscribe();
    };
  }, [t]);

  const isFirstShowHiddenFilesEffectRunRef = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: showHiddenFiles is a flip-detection trigger, not a read — the effect body reads refs only. Sibling pattern at the treePathsSignature reset effect above.
  useEffect(() => {
    if (isFirstShowHiddenFilesEffectRunRef.current) {
      isFirstShowHiddenFilesEffectRunRef.current = false;
      return;
    }
    refreshDocsScheduleRef.current?.();
  }, [showHiddenFiles]);

  useEffect(() => {
    let active = true;
    fetch('/api/workspace')
      .then(async (res) => {
        const data = await res.json();
        if (!active) return;
        if (!res.ok) return;
        const parsed = parseSuccessOrWarn(WorkspaceSuccessSchema, data, 'workspace', null);
        if (!parsed) return;
        setWorkspace({
          contentDir: parsed.contentDir,
          pathSeparator: parsed.pathSeparator,
        });
      })
      .catch((err) => {
        console.warn('[FileTree] /api/workspace fetch failed:', err);
      });
    return () => {
      active = false;
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: expandedPathsForReset reads refs; model + treePathsSignature are the reset triggers.
  useEffect(() => {
    if (skipNextResetSignatureRef.current === treePathsSignature) {
      skipNextResetSignatureRef.current = null;
      return;
    }
    model.resetPaths(treePathsRef.current, {
      initialExpandedPaths: expandedPathsForReset(),
    });
  }, [model, treePathsSignature]);

  useSelectionMirror(
    model,
    activeTreePath,
    activeAncestorTreePathsSignature,
    suppressSelectionRef,
    treePathsSignature,
  );

  useEffect(() => {
    if (!onContentHeightChange) return;
    let raf = 0;
    let attachRaf = 0;
    const getList = () =>
      (fileTreeHostRef.current
        ?.querySelector(FILE_TREE_TAG_NAME)
        ?.shadowRoot?.querySelector('[data-file-tree-virtualized-list]') as HTMLElement | null) ??
      null;
    const report = () => {
      const list = getList();
      if (!list) return;
      const h = Number.parseFloat(list.style.height);
      if (Number.isFinite(h)) onContentHeightChange(h);
    };
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(report);
    };
    const mo = new MutationObserver(report);
    const tryAttach = () => {
      const list = getList();
      if (list) {
        mo.observe(list, { attributes: true, attributeFilter: ['style'] });
        report();
      } else {
        attachRaf = requestAnimationFrame(tryAttach);
      }
    };
    tryAttach();
    const unsub = model.subscribe(measure);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(attachRaf);
      mo.disconnect();
      unsub();
      window.removeEventListener('resize', measure);
    };
  }, [onContentHeightChange, model]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: setCreationDirCleared is a stable state setter; baseActiveTreePath is the sole trigger.
  useEffect(() => {
    setCreationDirCleared(false);
  }, [baseActiveTreePath]);

  useEffect(() => {
    creationDirClearedRef.current = creationDirCleared;
    for (const listener of handleListenersRef.current) listener();
  }, [creationDirCleared]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: activeAncestorTreePathsSignature + treePathsSignature are re-run triggers — the row's visible index shifts when ancestors expand or the tree repopulates.
  useEffect(() => {
    if (loading || !activeTreePath) return;
    revealActiveRow(model);
  }, [activeTreePath, activeAncestorTreePathsSignature, treePathsSignature, loading, model]);

  useEffect(() => {
    return model.subscribe(() => {
      if (model.isSearchOpen()) return;
      for (const ancestor of activeAncestorTreePathsRef.current) {
        const item = asDirectoryHandle(model.getItem(ancestor));
        if (item && !item.isExpanded()) {
          item.expand();
        }
      }
    });
  }, [model]);

  useEffect(() => {
    return model.subscribe(() => detectLazyFolderExpansionsRef.current());
  }, [model]);

  useEffect(() => {
    return model.onMutation('remove', (event) => {
      const pending = pendingCreateRef.current;
      if (!pending || event.path !== pending.renamePath) return;
      void cleanupPendingCreateRef.current(pending);
    });
  }, [model]);

  const applyRenamedDocuments = async (
    renamed: RenamedDocMapping[],
    renamedFolders: RenamedFolderMapping[] = [],
    renamedAssets: RenamedAssetMapping[] = [],
    activeBeforeRename?: {
      docName: string | null;
      folderPath: string | null;
      assetPath: string | null;
    },
    renamedDocExtensions: RenamedDocExtensionMapping[] = [],
  ) => {
    const currentActiveDocName = activeBeforeRename?.docName ?? activeDocNameRef.current;
    const docToAssetRenames = new Map<string, string>();
    const assetToDocRenames = new Map<string, string>();
    for (const entry of documentsRef.current) {
      if (isDocumentEntry(entry)) {
        const assetPath = renamedAssets.find(
          (renamedAsset) =>
            renamedAsset.fromPath === docNameToTreePath(entry.docName, entry.docExt),
        )?.toPath;
        if (assetPath) docToAssetRenames.set(entry.docName, assetPath);
        continue;
      }
      if (isAssetEntry(entry)) {
        const docPath = renamedAssets.find(
          (renamedAsset) => renamedAsset.fromPath === entry.path,
        )?.toPath;
        if (docPath && hasSupportedDocumentExtension(docPath)) {
          assetToDocRenames.set(entry.path, treeFilePathToDocName(docPath));
        }
      }
    }
    const activeDocToAssetPath = currentActiveDocName
      ? (docToAssetRenames.get(currentActiveDocName) ?? null)
      : null;
    const currentActiveFolderPath =
      activeBeforeRename?.folderPath ??
      (activeTargetRef.current?.kind === 'folder' ? activeTargetRef.current.folderPath : null);
    const nextActiveFolderPath = currentActiveFolderPath
      ? remapPathForFolderRenames(currentActiveFolderPath, renamedFolders)
      : null;
    const currentActiveAssetPath =
      activeBeforeRename?.assetPath ??
      (activeTargetRef.current?.kind === 'asset' ? activeTargetRef.current.assetPath : null);
    const activeAssetToDoc = currentActiveAssetPath
      ? (assetToDocRenames.get(currentActiveAssetPath) ?? null)
      : null;
    const nextActiveDocName = activeDocToAssetPath
      ? null
      : (activeAssetToDoc ?? remapActiveDocName(currentActiveDocName, renamed));
    const nextActiveAssetPath =
      activeDocToAssetPath ??
      (currentActiveAssetPath
        ? activeAssetToDoc
          ? null
          : (renamedAssets.find((entry) => entry.fromPath === currentActiveAssetPath)?.toPath ??
            remapPathForFolderRenames(currentActiveAssetPath, renamedFolders))
        : null);

    captureRenameSnapshots(renamed);
    const cleanupDocNames = [
      ...planRenameCleanupCalls(renamed, getPoolActiveDocName(), poolHas),
      ...docToAssetRenames.keys(),
    ];
    await Promise.all(cleanupDocNames.map((docName) => closeAndClearForRename(docName)));
    for (const entry of renamed) {
      addPage(entry.toDocName);
    }
    for (const entry of assetToDocRenames.values()) {
      addPage(entry);
    }
    remapTabsForRename(renamed, renamedFolders, renamedAssets);

    let nextDocumentsForRename: FileEntry[] | null = null;
    setDocuments((current) => {
      const next = applyRenameToDocuments(
        current,
        renamed,
        renamedFolders,
        renamedAssets,
        renamedDocExtensions,
      );
      nextDocumentsForRename = next;
      reconcileModelAfterExtensionlessRename(current, next, renamed, renamedAssets);
      markNextDocumentsAsApplied(next);
      return next;
    });

    if (
      currentActiveFolderPath &&
      nextActiveFolderPath &&
      nextActiveFolderPath !== currentActiveFolderPath
    ) {
      navigateToFolderWithPulse(nextActiveFolderPath);
    } else if (nextActiveDocName && nextActiveDocName !== currentActiveDocName) {
      navigateToWithPulse(nextActiveDocName);
      focusEditorAfterRename(nextActiveDocName);
    } else if (
      nextActiveAssetPath &&
      (activeDocToAssetPath || nextActiveAssetPath !== currentActiveAssetPath)
    ) {
      navigateToAssetWithPulse(nextActiveAssetPath, nextDocumentsForRename ?? documentsRef.current);
    }
    emitDocumentsChanged(['files', 'backlinks', 'graph']);
  };

  async function handleTreeRename(event: FileTreeRenameEvent) {
    const sourceIsAsset = !event.isFolder && isAssetTreePath(event.sourcePath);
    const sourceTreePath = sourceIsAsset
      ? event.sourcePath
      : normalizeTreePathForKind(event.sourcePath, event.isFolder);

    setBusyPath(sourceTreePath);
    setError(null);

    try {
      const validation = validateAndCoerceRenameDestination(
        event.sourcePath,
        event.destinationPath,
        event.isFolder,
      );
      const documentBecomesFile =
        !event.isFolder &&
        !sourceIsAsset &&
        !hasSupportedDocumentExtension(validation.destinationPath);
      const destinationTreePath =
        sourceIsAsset || documentBecomesFile
          ? validation.destinationPath
          : normalizeTreePathForKind(validation.destinationPath, event.isFolder);

      const payload = event.isFolder
        ? {
            kind: 'folder' as const,
            fromPath: treeDirectoryPathToFolderPath(sourceTreePath),
            toPath: treeDirectoryPathToFolderPath(destinationTreePath),
          }
        : sourceIsAsset || documentBecomesFile
          ? {
              kind: 'asset' as const,
              fromPath: sourceTreePath,
              toPath: destinationTreePath,
            }
          : {
              kind: 'file' as const,
              fromPath: treeFilePathToDocName(sourceTreePath),
              toPath: destinationTreePath,
            };
      const activeBeforeRename = {
        docName: activeDocNameRef.current,
        folderPath:
          activeTargetRef.current?.kind === 'folder' ? activeTargetRef.current.folderPath : null,
        assetPath:
          activeTargetRef.current?.kind === 'asset' ? activeTargetRef.current.assetPath : null,
      };

      const res = await fetch('/api/rename-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const parsed = await parseServerResponse(res, t`Failed to rename path`);

      if (!parsed.ok) {
        toast.error(parsed.title);
        resetModelToDocuments();
        const pending = pendingCreateRef.current;
        if (pending && pending.renamePath === sourceTreePath) {
          await cleanupPendingCreate(pending);
        } else {
          clearPendingCreate();
        }
        setBusyPath(null);
        return;
      }

      const success = parseSuccessOrWarn(RenamePathSuccessSchema, parsed.body, 'rename-path', {
        renamed: [],
        renamedAssets: [],
      });
      try {
        await applyRenamedDocuments(
          success.renamed,
          event.isFolder
            ? [
                {
                  fromPath: treeDirectoryPathToFolderPath(sourceTreePath),
                  toPath: treeDirectoryPathToFolderPath(destinationTreePath),
                },
              ]
            : [],
          success.renamedAssets,
          activeBeforeRename,
          !event.isFolder && !sourceIsAsset && !documentBecomesFile
            ? success.renamed.flatMap((entry): RenamedDocExtensionMapping[] => {
                const docExt = getFileExtension(destinationTreePath);
                return docExt ? [{ toDocName: entry.toDocName, docExt }] : [];
              })
            : [],
        );
      } catch (reconcileErr) {
        console.warn('[FileTree] post-rename reconciliation failed', {
          err: reconcileErr,
          sourceTreePath,
          destinationTreePath,
          renamedCount: success.renamed.length,
          renamedAssetCount: success.renamedAssets.length,
        });
        toast.error(t`Rename succeeded but the sidebar may be out of date — refresh to resync`);
      }
      clearPendingCreate();
      setBusyPath(null);
    } catch (err) {
      console.warn('[FileTree] rename failed:', err);
      const msg = t`Network error — please try again`;
      toast.error(msg);
      setError(msg);
      resetModelToDocuments();
      const pending = pendingCreateRef.current;
      if (pending && pending.renamePath === sourceTreePath) {
        await cleanupPendingCreate(pending);
      } else {
        clearPendingCreate();
      }
      setBusyPath(null);
    }
  }

  async function handleDropComplete(event: FileTreeDropResult) {
    const operations = event.draggedPaths
      .map((sourcePath) => {
        const destinationTreePath = computeTreeDropDestinationPath(sourcePath, event.target);
        return sourcePath === destinationTreePath ? null : { sourcePath, destinationTreePath };
      })
      .filter((operation) => !!operation);
    if (operations.length === 0) return;

    setBusyPath(operations[0]?.sourcePath ?? null);
    setError(null);

    try {
      let renamed: RenamedDocMapping[] = [];
      let renamedAssets: RenamedAssetMapping[] = [];
      const renamedFolders: RenamedFolderMapping[] = [];
      const activeBeforeRename = {
        docName: activeDocNameRef.current,
        folderPath:
          activeTargetRef.current?.kind === 'folder' ? activeTargetRef.current.folderPath : null,
        assetPath:
          activeTargetRef.current?.kind === 'asset' ? activeTargetRef.current.assetPath : null,
      };
      for (const operation of operations) {
        const isFolder = operation.sourcePath.endsWith('/');
        const sourceIsAsset = !isFolder && isAssetTreePath(operation.sourcePath);
        const payload = isFolder
          ? {
              kind: 'folder' as const,
              fromPath: treeDirectoryPathToFolderPath(operation.sourcePath),
              toPath: treeDirectoryPathToFolderPath(operation.destinationTreePath),
            }
          : sourceIsAsset
            ? {
                kind: 'asset' as const,
                fromPath: operation.sourcePath,
                toPath: operation.destinationTreePath,
              }
            : {
                kind: 'file' as const,
                fromPath: treeFilePathToDocName(operation.sourcePath),
                toPath: treeFilePathToDocName(operation.destinationTreePath),
              };

        const res = await fetch('/api/rename-path', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const parsed = await parseServerResponse(res, t`Failed to move`);

        if (!parsed.ok) {
          toast.error(parsed.title);
          resetModelToDocuments();
          setBusyPath(null);
          return;
        }
        const success = parseSuccessOrWarn(
          RenamePathSuccessSchema,
          parsed.body,
          'rename-path:drop',
          { renamed: [], renamedAssets: [] },
        );
        renamed = renamed.concat(success.renamed);
        renamedAssets = renamedAssets.concat(success.renamedAssets);
        if (isFolder) {
          renamedFolders.push({
            fromPath: treeDirectoryPathToFolderPath(operation.sourcePath),
            toPath: treeDirectoryPathToFolderPath(operation.destinationTreePath),
          });
        }
      }

      try {
        await applyRenamedDocuments(renamed, renamedFolders, renamedAssets, activeBeforeRename);
      } catch (reconcileErr) {
        console.warn('[FileTree] post-move reconciliation failed', {
          err: reconcileErr,
          operationCount: operations.length,
          renamedCount: renamed.length,
          renamedAssetCount: renamedAssets.length,
        });
        toast.error(t`Move succeeded but the sidebar may be out of date — refresh to resync`);
      }
      setBusyPath(null);
    } catch (err) {
      console.warn('[FileTree] move failed:', err);
      toast.error(t`Network error — please try again`);
      resetModelToDocuments();
      setBusyPath(null);
    }
  }

  async function uploadExternalFilesToTarget(
    files: readonly File[],
    parentDir: string,
    uploadBusyPath: string,
  ) {
    if (files.length === 0 || busyPathRef.current !== null) return;

    const clearBusyState = () => {
      busyPathRef.current = null;
      setBusyPath(null);
    };
    busyPathRef.current = uploadBusyPath;
    setBusyPath(uploadBusyPath);
    setError(null);

    const uploadedEntries: FileEntry[] = [];
    let uploadedCount = 0;
    let failedCount = 0;

    for (const file of files) {
      const formData = new FormData();
      formData.append('file', file);
      formData.append(
        'parentDocName',
        uploadParentDocNameForFolderDrop(parentDir, file.name || 'upload'),
      );

      try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        const parsed = await parseServerResponse(res, t`Failed to upload file`);
        if (!parsed.ok) {
          failedCount += 1;
          toast.error(parsed.title, { description: file.name });
          continue;
        }

        const success = parseSuccessOrWarn(
          UploadAssetSuccessSchema,
          parsed.body,
          'upload:drop',
          null,
        );
        if (success === null) {
          failedCount += 1;
          toast.error(t`Failed to upload file`, { description: file.name });
          continue;
        }
        const uploadedPath = uploadedPathForSidebarDrop(parentDir, success);
        if (success.deduped === true) {
          failedCount += 1;
          toast.error(t`File already exists`, { description: uploadedPath });
          continue;
        }
        uploadedCount += 1;
        const entry = fileEntryFromUploadedPath(uploadedPath, file);
        if (entry) uploadedEntries.push(entry);
      } catch (err) {
        failedCount += 1;
        console.warn('[FileTree] external file upload failed:', err);
        toast.error(
          err instanceof TypeError ? t`Network error — please try again` : t`Failed to upload file`,
          {
            description: file.name,
          },
        );
      }
    }

    try {
      if (uploadedEntries.length > 0) {
        for (const entry of uploadedEntries) {
          if (isDocumentEntry(entry)) addPage(entry.docName);
        }
        setDocuments((current) => {
          const existing = new Set(current.map(fileEntryToTreePath));
          let changed = false;
          const next = [...current];
          for (const entry of uploadedEntries) {
            const treePath = fileEntryToTreePath(entry);
            recentLocalAddsRef.current.set(treePath, Date.now());
            if (existing.has(treePath)) continue;
            existing.add(treePath);
            next.push(entry);
            changed = true;
          }
          if (!changed) return current;
          resetModelToDocuments(next);
          markNextDocumentsAsApplied(next);
          return next;
        });
      }

      if (uploadedCount > 0) {
        emitDocumentsChanged(['files', 'backlinks', 'graph']);
        refreshDocsScheduleRef.current?.();
        toast.success(
          plural(uploadedCount, {
            one: 'Uploaded one file',
            other: `Uploaded ${uploadedCount} files`,
          }),
          { description: parentDir || t`Project root` },
        );
      }

      if (failedCount > 0) {
        setError(
          uploadedCount > 0
            ? plural(failedCount, {
                one: '1 file failed to upload',
                other: `${failedCount} files failed to upload`,
              })
            : t`Failed to upload file`,
        );
      }
      clearBusyState();
    } catch (err) {
      const message = t`Upload may have succeeded but the sidebar is out of date — refresh to resync`;
      console.warn('[FileTree] upload post-upload reconciliation failed:', err);
      toast.error(message);
      setError(message);
      clearBusyState();
    }
  }

  function startCreatingFromTemplate(parentDir: string) {
    setNewItemRequest({ parentDir });
  }

  async function startCreating(
    kind: 'file' | 'folder',
    parentDir: string,
    options?: { template?: string },
  ) {
    if (busyPathRef.current) return;

    const pendingCreate = pendingCreateRef.current;
    if (pendingCreate) {
      clearPendingCreate(pendingCreate);
    }

    try {
      const placeholder = createTreePlaceholder(kind, parentDir, [
        ...treePaths,
        ...folderTreePathsRef.current,
      ]);
      setBusyPath(placeholder.renamePath);
      busyPathRef.current = placeholder.renamePath;
      const previousHash = window.location.hash;

      let createdPath: string;
      if (kind === 'file') {
        const createPath = createPagePathFromTreeDestination('file', placeholder.addPath);
        const createBody: { path: string; template?: string } = { path: createPath };
        if (options?.template) createBody.template = options.template;
        const res = await fetch('/api/create-page', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(createBody),
        });
        const parsed = await parseServerResponse(res, t`Failed to create file`);

        if (!parsed.ok) {
          toast.error(parsed.title);
          setBusyPath(null);
          busyPathRef.current = null;
          return;
        }

        const fallbackDocName = treeFilePathToDocName(createPath);
        const success = parseSuccessOrWarn(CreatePageSuccessSchema, parsed.body, 'create-page', {
          docName: fallbackDocName,
        });
        const docName = success.docName;
        createdPath = docName;
        const docExt = createPath.toLowerCase().endsWith('.mdx') ? '.mdx' : '.md';
        const newFileEntry: FileEntry = {
          kind: 'document',
          docName,
          docExt,
          modified: new Date().toISOString(),
          size: 0,
        };
        addPage(docName);
        setDocuments((current) => {
          if (current.some((entry) => isDocumentEntry(entry) && entry.docName === docName)) {
            return current;
          }
          const next = [...current, newFileEntry];
          markNextDocumentsAsApplied(next);
          recentLocalAddsRef.current.set(fileEntryToTreePath(newFileEntry), Date.now());
          return next;
        });
        emitDocumentsChanged(['files', 'backlinks', 'graph']);
        navigateToWithPulse(docName);
      } else {
        const folderPath = treeDirectoryPathToFolderPath(placeholder.addPath);
        const res = await fetch('/api/create-folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: folderPath }),
        });
        const parsed = await parseServerResponse(res, t`Failed to create folder`);

        if (!parsed.ok) {
          toast.error(parsed.title);
          setBusyPath(null);
          busyPathRef.current = null;
          return;
        }

        const success = parseSuccessOrWarn(
          CreateFolderSuccessSchema,
          parsed.body,
          'create-folder',
          { path: folderPath },
        );
        createdPath = success.path;
        const newFolderEntry: FileEntry = {
          kind: 'folder',
          path: createdPath,
          modified: new Date().toISOString(),
          size: 0,
        };
        setDocuments((current) => {
          if (current.some((entry) => isFolderEntry(entry) && entry.path === createdPath)) {
            return current;
          }
          const next = [...current, newFolderEntry];
          markNextDocumentsAsApplied(next);
          recentLocalAddsRef.current.set(fileEntryToTreePath(newFolderEntry), Date.now());
          return next;
        });
        emitDocumentsChanged(['files']);
        navigateToFolderWithPulse(createdPath);
      }

      let disposed = false;
      const handleCommitKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'Enter') return;
        const pending = pendingCreateRef.current;
        if (!pending || pending.renamePath !== placeholder.renamePath) return;
        queueMicrotask(() => clearPendingCreate(pending));
      };
      const disposeCommitListener = () => {
        if (disposed) return;
        disposed = true;
        document.removeEventListener('keydown', handleCommitKeyDown, true);
      };
      document.addEventListener('keydown', handleCommitKeyDown, true);
      pendingCreateRef.current = {
        kind,
        renamePath: placeholder.renamePath,
        createdPath,
        previousHash,
        disposeCommitListener,
      };
      setBusyPath(null);
      busyPathRef.current = null;
      model.add(placeholder.addPath);
      model.startRenaming(placeholder.renamePath, { removeIfCanceled: true });
    } catch (err) {
      console.warn('[FileTree] create placeholder failed:', err);
      toast.error(t`Could not start creating a new item`);
      const pending = pendingCreateRef.current;
      if (pending) {
        await cleanupPendingCreate(pending);
      } else {
        clearPendingCreate();
      }
      setBusyPath(null);
      busyPathRef.current = null;
      resetModelToDocuments();
    }
  }

  function expandSubtree(treePath: string) {
    const root = folderPathToTreeDirectoryPath(treePath);
    startTransition(() => {
      for (const folderPath of folderTreePathsRef.current) {
        if (folderPath === root || folderPath.startsWith(root)) {
          const item = asDirectoryHandle(model.getItem(folderPath));
          if (item) {
            item.expand();
          }
        }
      }
    });
  }

  function collapseSubtree(treePath: string) {
    const root = folderPathToTreeDirectoryPath(treePath);
    const activeAncestors = new Set(activeAncestorTreePathsRef.current);
    startTransition(() => {
      for (const folderPath of [...folderTreePathsRef.current].reverse()) {
        if (
          (folderPath === root || folderPath.startsWith(root)) &&
          !activeAncestors.has(folderPath)
        ) {
          const item = asDirectoryHandle(model.getItem(folderPath));
          if (item) {
            item.collapse();
          }
        }
      }
    });
  }

  useLayoutEffect(() => {
    documentsRef.current = documents;
    pageMetaRef.current = pageMeta;
    activeDocNameRef.current = activeDocName;
    activeTargetRef.current = activeTarget;
    assetTreePathsRef.current = assetTreePaths;
    busyPathRef.current = busyPath;
    showHiddenFilesRef.current = showHiddenFiles;
    treePathsRef.current = treePaths;
    folderTreePathsRef.current = folderTreePaths;
    activeAncestorTreePathsRef.current = activeAncestorTreePaths;
    detectLazyFolderExpansionsRef.current = detectLazyFolderExpansions;
    revalidateExpandedLazyDirsRef.current = revalidateExpandedLazyDirs;
    cleanupPendingCreateRef.current = cleanupPendingCreate;
    uploadExternalFilesRef.current = (files, parentDir, uploadBusyPath) => {
      void uploadExternalFilesToTarget(files, parentDir, uploadBusyPath);
    };
    handleSelectionChangeRef.current = (selectedPaths) => {
      if (suppressSelectionRef.current || sidebarDragInProgressRef.current) return;
      if (selectedPaths.length !== 1) return;
      const selected = selectedPaths[0];
      if (selected) {
        setCreationDirCleared(false);
        activateTreePath(normalizeSelectionPath(selected), documents);
      }
    };
    handleRenameErrorRef.current = (message) => {
      if (recoverMarkdownRenameConflict(message)) return;
      toast.error(message);
    };
    handleRenameRef.current = handleTreeRename;
    handleDropCompleteRef.current = handleDropComplete;
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isPlatformShortcut = (event.metaKey || event.ctrlKey) && !event.altKey;
      const key = event.key.toLowerCase();
      const isSelectAll = isPlatformShortcut && key === 'a';
      const isDuplicate = isPlatformShortcut && !event.shiftKey && key === 'd';
      if (!isSelectAll && !isDuplicate) return;
      if (isEditableKeyboardTarget(event.target)) return;

      const host = fileTreeHostRef.current;
      const target = event.target;
      const activeElement = document.activeElement;
      const eventStartedInTree = target instanceof Node && host?.contains(target);
      const focusIsInTree = activeElement instanceof Node && host?.contains(activeElement);
      if (!eventStartedInTree && !focusIsInTree) return;

      if (isDuplicate) {
        const selectedPath = model.getFocusedPath() ?? model.getSelectedPaths()[0] ?? null;
        if (!selectedPath) return;
        const selectedItem =
          model.getItem(selectedPath) ?? model.getItem(folderPathToTreeDirectoryPath(selectedPath));
        const normalizedPath = selectedItem?.isDirectory()
          ? folderPathToTreeDirectoryPath(treeDirectoryPathToFolderPath(selectedItem.getPath()))
          : selectedPath;
        if (assetTreePathsRef.current.has(normalizedPath)) return;
        void handleDuplicateTargetRef.current(
          treePathToTarget(normalizedPath, documentsRef.current),
        );
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const selectedPaths = new Set([...folderTreePathsRef.current, ...treePathsRef.current]);
      suppressSelectionRef.current = true;
      for (const treePath of selectedPaths) {
        if (!treePath) continue;
        model.getItem(treePath)?.select();
      }
      queueMicrotask(() => {
        suppressSelectionRef.current = false;
      });
      event.preventDefault();
      event.stopPropagation();
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [model]);

  useEffect(() => {
    if (loading || documents.length === 0) return;
    const shadow = fileTreeHostRef.current?.querySelector(FILE_TREE_TAG_NAME)?.shadowRoot;
    if (!shadow) return;
    const toTitle = (treePath: string) =>
      treePath.endsWith('/') ? treePath.slice(0, -1) : treePath;
    const stampTitles = () => {
      for (const row of shadow.querySelectorAll<HTMLElement>('[data-item-path]')) {
        const treePath = row.dataset.itemPath;
        if (!treePath) continue;
        const title = toTitle(treePath);
        if (row.title !== title) row.title = title;
      }
      const anchor = shadow.querySelector<HTMLElement>('[data-type="context-menu-anchor"]');
      if (anchor) {
        const hoveredPath = shadow.querySelector<HTMLElement>(
          '[data-item-context-hover="true"][data-item-path]',
        )?.dataset.itemPath;
        const title = hoveredPath ? toTitle(hoveredPath) : '';
        if (anchor.title !== title) anchor.title = title;
      }
    };
    stampTitles();
    const observer = new MutationObserver(stampTitles);
    observer.observe(shadow, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-item-path', 'data-item-context-hover'],
    });
    return () => observer.disconnect();
  }, [loading, documents.length]);

  useEffect(() => {
    if (loading || documents.length === 0) return;
    const shadow = fileTreeHostRef.current?.querySelector(FILE_TREE_TAG_NAME)?.shadowRoot;
    if (!shadow) return;
    const apply = () => applyExtensionBadges(shadow);
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(shadow, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-item-path'],
    });
    return () => observer.disconnect();
  }, [loading, documents.length]);

  useEffect(() => {
    if (loading || documents.length === 0) return;
    const shadow = fileTreeHostRef.current?.querySelector(FILE_TREE_TAG_NAME)?.shadowRoot;
    if (!shadow) return;
    const apply = () => applyRenameInputAffordance(shadow);
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(shadow, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-item-path'],
    });
    return () => observer.disconnect();
  }, [loading, documents.length]);

  const folderStateCacheRef = useRef<{ folderCount: number; expandedCount: number }>({
    folderCount: 0,
    expandedCount: 0,
  });

  const startCreatingRef = useRef(startCreating);
  const startCreatingFromTemplateRef = useRef(startCreatingFromTemplate);
  useEffect(() => {
    startCreatingRef.current = startCreating;
    startCreatingFromTemplateRef.current = startCreatingFromTemplate;
  });

  useImperativeHandle(
    ref,
    () => ({
      startCreating(kind, parentDir) {
        void startCreatingRef.current(kind, parentDir);
      },
      startCreatingFromTemplate(parentDir) {
        startCreatingFromTemplateRef.current(parentDir);
      },
      createFromTemplate(parentDir, templateName) {
        void startCreatingRef.current('file', parentDir, { template: templateName });
      },
      expandAll() {
        startTransition(() => {
          for (const folderPath of folderTreePathsRef.current) {
            const item = asDirectoryHandle(model.getItem(folderPath));
            if (item) {
              item.expand();
            }
          }
        });
      },
      collapseAll() {
        const activeAncestors = new Set(activeAncestorTreePathsRef.current);
        startTransition(() => {
          for (const folderPath of [...folderTreePathsRef.current].reverse()) {
            if (activeAncestors.has(folderPath)) continue;
            const item = asDirectoryHandle(model.getItem(folderPath));
            if (item) {
              item.collapse();
            }
          }
        });
      },
      getFolderState() {
        const paths = folderTreePathsRef.current;
        let expandedCount = 0;
        for (const p of paths) {
          if (asDirectoryHandle(model.getItem(p))?.isExpanded()) expandedCount++;
        }
        const folderCount = paths.length;
        const cached = folderStateCacheRef.current;
        if (cached.folderCount === folderCount && cached.expandedCount === expandedCount) {
          return cached;
        }
        const next = { folderCount, expandedCount };
        folderStateCacheRef.current = next;
        return next;
      },
      isCreationTargetCleared() {
        return creationDirClearedRef.current;
      },
      clearCreationTarget() {
        setCreationDirCleared(true);
      },
      subscribe(listener: () => void) {
        handleListenersRef.current.add(listener);
        const unsubscribeModel = model.subscribe(listener);
        return () => {
          handleListenersRef.current.delete(listener);
          unsubscribeModel();
        };
      },
    }),
    [model],
  );

  async function applyDeleteAftermath(
    successfulTargets: readonly FileTreeTarget[],
    deletedDocNames: readonly string[],
    deletedFolderPaths: readonly string[],
  ) {
    const tabsToClose = collectTabsToCloseForDelete(
      successfulTargets,
      documentsRef.current,
      folderTreePathsRef.current,
    );
    const pendingCreate = pendingCreateRef.current;
    if (
      pendingCreate &&
      successfulTargets.some((target) => deleteTargetCoversPendingCreate(target, pendingCreate))
    ) {
      if (pendingCreate.kind === 'file') {
        tabsToClose.docNames.add(pendingCreate.createdPath);
      } else {
        tabsToClose.folderPaths.add(pendingCreate.createdPath);
      }
      clearPendingCreate(pendingCreate);
    }
    const deleted = new Set([...tabsToClose.docNames, ...deletedDocNames]);
    const deletedFolders = new Set([...tabsToClose.folderPaths, ...deletedFolderPaths]);
    const deletedAssets = new Set([
      ...tabsToClose.assetPaths,
      ...successfulTargets.filter((target) => target.kind === 'asset').map((target) => target.path),
    ]);
    closeTabs(
      [
        ...[...deleted].map((docName) => docTabId(docName)),
        ...[...deletedFolders].map((folderPath) => folderTabId(folderPath)),
        ...[...deletedAssets].map((assetPath) => assetTabId(assetPath)),
      ],
      { force: true },
    );
    await Promise.all([...deleted].map((docName) => closeAndClearForRename(docName)));

    for (const target of successfulTargets) {
      const treePath =
        target.kind === 'folder'
          ? folderPathToTreeDirectoryPath(target.path)
          : target.kind === 'asset'
            ? target.path
            : docNameToTreePath(target.path, target.docExt);
      if (model.getItem(treePath)) {
        model.remove(treePath, target.kind === 'folder' ? { recursive: true } : undefined);
      }
    }
    setDocuments((current) => {
      let next = applyDeleteToDocuments(current, [...deleted], undefined, [...deletedAssets]);
      for (const folderPath of deletedFolders) {
        next = applyDeleteToDocuments(next, [], folderPath);
      }
      markNextDocumentsAsApplied(next);
      return next;
    });
    emitDocumentsChanged(['files', 'backlinks', 'graph']);
  }

  async function hardDeleteTargets(targets: readonly FileTreeTarget[]): Promise<boolean> {
    const deletedDocNames: string[] = [];
    const deletedFolderPaths: string[] = [];
    const successfulTargets: FileTreeTarget[] = [];
    for (const target of targets) {
      const kind = target.kind;
      setBusyPath(target.path);
      const res = await fetch('/api/delete-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, path: target.path }),
      });
      const parsed = await parseServerResponse(res, t`Failed to delete path`);
      if (!parsed.ok) {
        if (successfulTargets.length > 0) {
          await applyDeleteAftermath(successfulTargets, deletedDocNames, deletedFolderPaths);
        }
        toast.error(parsed.title);
        return false;
      }
      const success = parseSuccessOrWarn(DeletePathSuccessSchema, parsed.body, 'delete-path', {
        deletedDocNames: [],
      });
      deletedDocNames.push(...success.deletedDocNames);
      if (kind === 'folder') {
        deletedFolderPaths.push(target.path);
      }
      successfulTargets.push(target);
    }
    await applyDeleteAftermath(successfulTargets, deletedDocNames, deletedFolderPaths);
    return true;
  }

  async function trashTargetsViaShell(
    targets: readonly FileTreeTarget[],
    bridge: NonNullable<typeof window.okDesktop>,
    workspaceInfo: WorkspaceInfo,
  ): Promise<{
    trashed: FileTreeTarget[];
    failed: TrashFailedTarget[];
  }> {
    const trashed: FileTreeTarget[] = [];
    const failed: TrashFailedTarget[] = [];
    for (const target of targets) {
      setBusyPath(target.path);
      const absPath = buildTrashAbsPath(target, workspaceInfo);
      const result = await bridge.shell.trashItem(absPath);
      if (result.ok) {
        trashed.push(target);
      } else {
        failed.push({
          kind: target.kind,
          path: target.path,
          name: target.name,
          reason: coerceTrashFailureReason(result.reason),
          detail: result.detail,
        });
      }
    }
    return { trashed, failed };
  }

  async function postTrashCleanup(
    trashed: readonly FileTreeTarget[],
  ): Promise<{ deletedDocNames: string[]; deletedFolderPaths: string[] } | null> {
    const deletedDocNames: string[] = [];
    const deletedFolderPaths: string[] = [];
    const failedCleanups: Array<{ target: FileTreeTarget; reason: string }> = [];
    for (const target of trashed) {
      const kind = target.kind;
      try {
        const res = await fetch('/api/trash/cleanup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind, path: target.path }),
        });
        const parsed = await parseServerResponse(res, t`Failed to clean up after trash`);
        if (!parsed.ok) {
          console.warn('[FileTree] trash-cleanup failed', {
            target: `${target.kind}:${target.path}`,
            reason: parsed.title,
          });
          failedCleanups.push({ target, reason: parsed.title });
          continue;
        }
        const success = parseSuccessOrWarn(
          TrashCleanupSuccessSchema,
          parsed.body,
          'trash-cleanup',
          { deletedDocNames: [] },
        );
        deletedDocNames.push(...success.deletedDocNames);
        if (kind === 'folder') {
          deletedFolderPaths.push(target.path);
        }
      } catch (err) {
        console.warn('[FileTree] trash-cleanup threw', {
          target: `${target.kind}:${target.path}`,
          err,
        });
        failedCleanups.push({ target, reason: t`Network error during cleanup` });
      }
    }
    if (failedCleanups.length > 0) {
      const failedCount = failedCleanups.length;
      toast.error(
        t`Server-side cleanup failed for ${plural(failedCount, { one: '# item', other: '# items' })}`,
        {
          description: t`The file is in your Trash; the file-watcher will reconcile.`,
        },
      );
    }
    if (failedCleanups.length === trashed.length && trashed.length > 0) {
      return null;
    }
    return { deletedDocNames, deletedFolderPaths };
  }

  async function handleDeleteTargets(targets: FileTreeTarget[]) {
    const deleteTargets = targets.map((target) =>
      canonicalizeAssetTargetForDelete(target, documentsRef.current),
    );
    const firstTarget = deleteTargets[0];
    if (!firstTarget) return;

    const blockingConflicts = activeConflicts.filter((c) =>
      deleteTargets.some((t) => {
        if (t.kind === 'file') {
          const fileWithExt = `${t.path}${t.docExt ?? '.md'}`;
          return c.file === fileWithExt;
        }
        if (t.kind === 'folder') return c.file.startsWith(`${t.path}/`);
        return false;
      }),
    );
    if (blockingConflicts.length > 0) {
      const sample = blockingConflicts.slice(0, 3).map((c) => c.file);
      const rest =
        blockingConflicts.length > sample.length
          ? `, +${blockingConflicts.length - sample.length} more`
          : '';
      toast.error('Cannot delete files with unresolved conflicts', {
        description: `Resolve the conflict on ${sample.join(', ')}${rest} before deleting.`,
      });
      return;
    }

    setBusyPath(firstTarget.path);
    setDeleteRequest(null);

    const bridge = typeof window !== 'undefined' ? window.okDesktop : undefined;
    try {
      if (bridge && workspace) {
        const { trashed, failed } = await trashTargetsViaShell(deleteTargets, bridge, workspace);
        if (trashed.length > 0) {
          const cleanup = await postTrashCleanup(trashed);
          if (cleanup) {
            await applyDeleteAftermath(
              trashed,
              cleanup.deletedDocNames,
              cleanup.deletedFolderPaths,
            );
          } else {
            const localDocNames = trashed.filter((t) => t.kind === 'file').map((t) => t.path);
            const localFolderPaths = trashed.filter((t) => t.kind === 'folder').map((t) => t.path);
            await applyDeleteAftermath(trashed, localDocNames, localFolderPaths);
          }
        }
        if (failed.length > 0) {
          setTrashFailure({ failed, originalTargets: [...deleteTargets] });
        }
        setBusyPath(null);
      } else {
        const ok = await hardDeleteTargets(deleteTargets);
        setBusyPath(null);
        if (!ok) resetModelToDocuments();
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn('[FileTree] delete failed:', err);
      toast.error(t`Could not complete delete`, { description: detail });
      setBusyPath(null);
      resetModelToDocuments();
    }
  }

  async function handleTrashFailureDeletePermanently() {
    if (!trashFailure) return;
    const failedSet = new Set(trashFailure.failed.map((t) => `${t.kind}:${t.path}`));
    const targetsToHardDelete = trashFailure.originalTargets.filter((t) =>
      failedSet.has(`${t.kind}:${t.path}`),
    );
    setTrashFailure(null);
    if (targetsToHardDelete.length === 0) return;
    setBusyPath(targetsToHardDelete[0]?.path ?? null);
    try {
      const ok = await hardDeleteTargets(targetsToHardDelete);
      setBusyPath(null);
      if (!ok) resetModelToDocuments();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn('[FileTree] hard-delete fallback failed:', err);
      toast.error(t`Could not complete delete`, { description: detail });
      setBusyPath(null);
      resetModelToDocuments();
    }
  }

  async function handleTrashFailureRetry() {
    if (!trashFailure) return;
    const failedSet = new Set(trashFailure.failed.map((f) => `${f.kind}:${f.path}`));
    const originals = trashFailure.originalTargets.filter((t) =>
      failedSet.has(`${t.kind}:${t.path}`),
    );
    setTrashFailure(null);
    await handleDeleteTargets(originals);
  }

  const handleDeleteTargetsRef = useRef(handleDeleteTargets);
  useEffect(() => {
    handleDeleteTargetsRef.current = handleDeleteTargets;
  });

  useEffect(() => {
    return subscribeToFileTreeMenuActionDelete((target) => {
      if (target.kind === 'doc' || target.kind === 'folder-index') {
        const docName = target.docName;
        const docEntry = documentsRef.current.find(
          (entry): entry is DocumentEntry => isDocumentEntry(entry) && entry.docName === docName,
        );
        void handleDeleteTargetsRef.current([
          {
            kind: 'file',
            path: docName,
            name: docName.split('/').pop() ?? docName,
            docExt: docEntry?.docExt,
          },
        ]);
        return;
      }
      if (target.kind === 'folder') {
        void handleDeleteTargetsRef.current([
          {
            kind: 'folder',
            path: target.folderPath,
            name: target.folderPath.split('/').pop() ?? target.folderPath,
          },
        ]);
        return;
      }
      if (target.kind === 'asset') {
        void handleDeleteTargetsRef.current([
          {
            kind: 'asset',
            path: target.assetPath,
            name: target.assetPath.split('/').pop() ?? target.assetPath,
          },
        ]);
        return;
      }
      console.warn(
        JSON.stringify({
          event: 'file-tree-menu-action-delete-unsupported-kind',
          kind: target.kind,
        }),
      );
    });
  }, []);

  useEffect(() => {
    return subscribeToFileTreeMenuActionDuplicate((target: ResolvedNavigationTarget) => {
      if (target.kind === 'doc' || target.kind === 'folder-index') {
        const docName = target.docName;
        const docEntry = documentsRef.current.find(
          (entry): entry is DocumentEntry => isDocumentEntry(entry) && entry.docName === docName,
        );
        void handleDuplicateTargetRef.current({
          kind: 'file',
          path: docName,
          name: docName.split('/').pop() ?? docName,
          docExt: docEntry?.docExt,
        });
        return;
      }
      if (target.kind === 'folder') {
        void handleDuplicateTargetRef.current({
          kind: 'folder',
          path: target.folderPath,
          name: target.folderPath.split('/').pop() ?? target.folderPath,
        });
        return;
      }
      console.warn(
        JSON.stringify({
          event: 'file-tree-menu-action-duplicate-unsupported-kind',
          kind: target.kind,
        }),
      );
    });
  }, []);

  useEffect(() => {
    return subscribeToFileTreeMenuActionRename((target) => {
      if (target.kind === 'doc' || target.kind === 'folder-index') {
        const docName = target.docName;
        const docEntry = documentsRef.current.find(
          (entry): entry is DocumentEntry => isDocumentEntry(entry) && entry.docName === docName,
        );
        const treePath = docNameToTreePath(docName, docEntry?.docExt);
        model.startRenaming(treePath);
        return;
      }
      if (target.kind === 'folder') {
        model.startRenaming(target.folderPath);
        return;
      }
      if (target.kind === 'asset') {
        model.startRenaming(target.assetPath);
        return;
      }
      console.warn(
        JSON.stringify({
          event: 'file-tree-menu-action-rename-unsupported-kind',
          kind: target.kind,
        }),
      );
    });
  }, [model]);

  function cancelCurrentHoverPrewarm() {
    const current = hoveredPrewarmDocRef.current;
    if (current) cancelHoverPrewarm(current);
    hoveredPrewarmDocRef.current = null;
  }

  function handleTreeMouseMove(event: ReactMouseEvent<HTMLElement>) {
    const path = findTreeItemPath(event.nativeEvent);
    if (!path || path.endsWith('/')) {
      cancelCurrentHoverPrewarm();
      return;
    }
    const docName = treeFilePathToDocName(path);
    const entry = documentsRef.current.find((item) => fileEntryToTreePath(item) === path);
    if (entry && isAssetEntry(entry)) {
      cancelCurrentHoverPrewarm();
      return;
    }
    if (entry && isDocumentEntry(entry) && isDocumentOverOpenByteLimit(entry.size)) {
      cancelCurrentHoverPrewarm();
      return;
    }
    if (hoveredPrewarmDocRef.current === docName) return;
    cancelCurrentHoverPrewarm();
    hoveredPrewarmDocRef.current = docName;
    scheduleHoverPrewarm(docName, (nextDocName) => prewarm(nextDocName));
  }

  function handleTreeClickCapture(event: ReactMouseEvent<HTMLElement>) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const item = findTreeItemElement(event.nativeEvent);
    if (!item) {
      if (clickIsInTreeContentArea(event.nativeEvent)) {
        setCreationDirCleared(true);
      }
      return;
    }
    if (item.getAttribute('aria-selected') !== 'true') return;

    const rawPath = item.dataset.itemPath;
    if (!rawPath) return;

    const path =
      item.dataset.itemType === 'folder' ? folderPathToTreeDirectoryPath(rawPath) : rawPath;
    if (model.getSelectedPaths().length !== 1) return;

    if (item.dataset.itemType === 'folder') {
      const folderPath = treeDirectoryPathToFolderPath(path);
      if (window.location.hash === hashFromFolderPath(folderPath)) return;
      queueMicrotask(() => navigateToFolderWithPulse(folderPath));
      return;
    }

    const docName = treeFilePathToDocName(path);
    if (window.location.hash === hashFromDocName(docName)) return;
    queueMicrotask(() => activateTreePath(path));
  }

  function handleEmptyExternalFileDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (!isExternalFileDrag(event.nativeEvent)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setEmptyExternalFileDropActive(true);
  }

  function handleEmptyExternalFileDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    const related = event.relatedTarget;
    if (related instanceof Node && event.currentTarget.contains(related)) return;
    setEmptyExternalFileDropActive(false);
  }

  function handleEmptyExternalFileDrop(event: ReactDragEvent<HTMLDivElement>) {
    if (!isExternalFileDrag(event.nativeEvent)) return;
    const files = filesFromExternalDrop(event.nativeEvent);
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    setEmptyExternalFileDropActive(false);
    void uploadExternalFilesToTarget(files, '', FILE_TREE_EXTERNAL_FILE_DROP_BUSY_PATH);
  }

  if (loading) {
    return <FileTreeSkeleton />;
  }

  const reconnectNotice = reconnecting
    ? relaunchInFlight
      ? t`Relaunching to install the update…`
      : t`Reconnecting…`
    : null;

  if (documents.length === 0) {
    if (reconnectNotice !== null) {
      return (
        <div className="flex flex-1 items-center justify-center py-8">
          <span role="status" className="select-none text-sidebar-foreground/50 text-sm">
            {reconnectNotice}
          </span>
        </div>
      );
    }
    if (error) {
      return (
        <div className="flex flex-1 items-center justify-center py-8">
          <span role="alert" className="select-none text-sidebar-foreground/50 text-sm">
            {error}
          </span>
        </div>
      );
    }
    return (
      <section
        aria-label={t`File drop zone`}
        className={cn(
          'flex flex-1 flex-col items-center justify-center gap-3 rounded-md py-8',
          emptyExternalFileDropActive && 'bg-primary/5 ring-2 ring-primary/70 ring-inset',
        )}
        onDragOver={handleEmptyExternalFileDragOver}
        onDragLeave={handleEmptyExternalFileDragLeave}
        onDrop={handleEmptyExternalFileDrop}
      >
        <span className="select-none text-sidebar-foreground/30 text-sm">
          <Trans>No files yet.</Trans>
        </span>
        <Button
          variant="link"
          size="sm"
          className="font-mono uppercase"
          onClick={() => startCreating('file', '')}
        >
          <Trans>Create your first file</Trans>
        </Button>
      </section>
    );
  }

  const anyActionBusy = busyPath !== null;
  const primaryDeleteTarget = deleteRequest?.targets[0] ?? null;
  let truncationNotice: string | null = null;
  if (truncatedShownCount !== null) {
    const formattedCount = new Intl.NumberFormat(i18n.locale).format(truncatedShownCount);
    truncationNotice = plural(truncatedShownCount, {
      one: 'Showing the first item in one folder — the rest of that folder is hidden.',
      other: `Showing the first ${formattedCount} items in one folder — the rest of that folder is hidden.`,
    });
  }
  return (
    <>
      <div ref={fileTreeHostRef} className="flex min-h-0 flex-1 flex-col">
        <PierreFileTree
          header={
            (error || reconnectNotice !== null || truncationNotice !== null) && (
              <>
                {reconnectNotice !== null ? (
                  <FileTreeHeaderNotice kind="reconnecting">{reconnectNotice}</FileTreeHeaderNotice>
                ) : (
                  error && <FileTreeHeaderNotice kind="error">{error}</FileTreeHeaderNotice>
                )}
                {truncationNotice !== null && (
                  <FileTreeHeaderNotice kind="info">{truncationNotice}</FileTreeHeaderNotice>
                )}
              </>
            )
          }
          model={model}
          style={createFileTreeStyle(resolvedTheme)}
          {...{ [FILE_TREE_CREATION_CLEARED_ATTR]: creationDirCleared ? '' : undefined }}
          onClickCapture={handleTreeClickCapture}
          onMouseMove={handleTreeMouseMove}
          onMouseLeave={cancelCurrentHoverPrewarm}
          renderContextMenu={(item, context) => (
            <FileTreeMenu
              item={item}
              context={context}
              anyActionBusy={anyActionBusy}
              workspace={workspace}
              handoff={handoff}
              model={model}
              okignoreBinding={okignoreBinding}
              projectLocalBinding={projectLocalBinding}
              mergedConfig={merged}
              onStartCreating={startCreating}
              onCreateFromTemplate={(parentDir, templateName) =>
                startCreating('file', parentDir, { template: templateName })
              }
              onDuplicate={handleDuplicateTarget}
              onDelete={(targets) => setDeleteRequest({ targets })}
              onExpandSubtree={expandSubtree}
              onCollapseSubtree={collapseSubtree}
              folderTreePaths={folderTreePaths}
              isAsset={assetTreePaths.has(item.path)}
              documents={documents}
            />
          )}
        />
      </div>
      <Dialog
        open={!!deleteRequest}
        onOpenChange={(open) => {
          if (!open && !busyPath) setDeleteRequest(null);
        }}
      >
        {deleteRequest && primaryDeleteTarget && (
          <DeleteConfirmationDialog
            {...(() => {
              const variant: 'electron' | 'web' =
                typeof window !== 'undefined' && window.okDesktop != null ? 'electron' : 'web';
              const copy = selectTrashConfirmCopy(variant, deleteRequest.targets);
              if (copy) {
                return {
                  customTitle: copy.title,
                  customDescription: '',
                  customDetail: copy.detail,
                  customConfirmLabel: copy.confirmLabel,
                  customConfirmLabelBusy: copy.confirmLabelBusy,
                  children: copy.listedTargets ? (
                    <ul className="flex flex-col gap-1 font-mono text-foreground text-xs">
                      {copy.listedTargets.map((target) => (
                        <li key={`${target.kind}:${target.path}`} data-testid="delete-target-row">
                          {trashTargetDisplayName(target)}
                        </li>
                      ))}
                    </ul>
                  ) : null,
                };
              }
              const targetCount = deleteRequest.targets.length;
              const folderName = primaryDeleteTarget.name;
              return {
                itemName:
                  targetCount === 1
                    ? primaryDeleteTarget.kind === 'folder'
                      ? `${primaryDeleteTarget.name}/`
                      : primaryDeleteTarget.kind === 'file'
                        ? `${primaryDeleteTarget.name}${primaryDeleteTarget.docExt ?? '.md'}`
                        : primaryDeleteTarget.name
                    : undefined,
                customTitle: targetCount > 1 ? t`Delete selected items` : undefined,
                customDescription:
                  targetCount > 1
                    ? t`Are you sure you want to delete ${targetCount} selected items? Folders and all files inside them will be deleted. This action cannot be undone.`
                    : primaryDeleteTarget.kind === 'folder'
                      ? t`Are you sure you want to delete ${folderName}/ and all files inside? This action cannot be undone.`
                      : undefined,
              };
            })()}
            isSubmitting={busyPath !== null}
            onDelete={() => handleDeleteTargets(deleteRequest.targets)}
          />
        )}
      </Dialog>
      <Dialog
        open={!!trashFailure}
        onOpenChange={(open) => {
          if (!open && !busyPath) setTrashFailure(null);
        }}
      >
        {trashFailure && (
          <TrashFailureModal
            failedTargets={trashFailure.failed}
            isSubmitting={busyPath !== null}
            onDeletePermanently={handleTrashFailureDeletePermanently}
            onRetry={handleTrashFailureRetry}
            onCancel={() => setTrashFailure(null)}
          />
        )}
      </Dialog>
      <NewItemDialog
        open={newItemRequest !== null}
        onOpenChange={(open) => {
          if (!open) setNewItemRequest(null);
        }}
        kind="file"
        initialDir={newItemRequest?.parentDir ?? ''}
        defaultToTemplate
      />
    </>
  );
}

function findTreeItemPath(event: MouseEvent): string | null {
  return findTreeItemElement(event)?.dataset.itemPath ?? null;
}

function findTreeItemElement(event: MouseEvent): HTMLElement | null {
  for (const entry of event.composedPath()) {
    if (entry instanceof HTMLElement && entry.dataset.itemPath) {
      return entry;
    }
  }
  return null;
}

function findTreeVirtualizedRootElement(event: MouseEvent): HTMLElement | null {
  for (const entry of event.composedPath()) {
    if (entry instanceof HTMLElement && entry.matches('[data-file-tree-virtualized-root]')) {
      return entry;
    }
  }
  return null;
}

function resolveExternalFileDropTarget(event: MouseEvent): ExternalFileDropTarget | null {
  const item = findTreeItemElement(event);
  if (item) {
    const rawPath = item.dataset.itemPath;
    if (!rawPath) return null;
    const isFolder = item.dataset.itemType === 'folder';
    const parentDir = parentFolderPathForTreeItemDropTarget(rawPath, isFolder);
    return {
      parentDir,
      row: item,
      root: null,
      busyPath: isFolder ? folderPathToTreeDirectoryPath(parentDir) : rawPath,
    };
  }
  if (!clickIsInTreeContentArea(event)) return null;
  return {
    parentDir: '',
    row: null,
    root: findTreeVirtualizedRootElement(event),
    busyPath: FILE_TREE_EXTERNAL_FILE_DROP_BUSY_PATH,
  };
}

function clickIsInTreeContentArea(event: MouseEvent): boolean {
  for (const entry of event.composedPath()) {
    if (entry instanceof HTMLElement && entry.matches('[data-file-tree-virtualized-scroll]')) {
      return true;
    }
  }
  return false;
}

const FILE_TREE_SKELETON_ROW_WIDTHS = ['w-3/4', 'w-2/3', 'w-4/5', 'w-1/2', 'w-3/5', 'w-2/3'];

function FileTreeSkeleton() {
  const { t } = useLingui();
  return (
    <div
      className="flex flex-1 flex-col gap-1 px-2 py-2"
      role="status"
      aria-busy="true"
      aria-label={t`Loading files`}
    >
      {FILE_TREE_SKELETON_ROW_WIDTHS.map((width, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static decoration list
          key={index}
          className="flex h-6 items-center gap-2"
        >
          <Skeleton className="h-3 w-3 shrink-0 rounded-sm" />
          <Skeleton className={`h-3 ${width}`} />
        </div>
      ))}
    </div>
  );
}

function FileTreeHeaderNotice({
  kind,
  children,
}: {
  kind: 'error' | 'info' | 'reconnecting';
  children: ReactNode;
}) {
  const Icon = kind === 'error' ? TriangleAlert : kind === 'reconnecting' ? RefreshCw : Info;
  return (
    <span
      role={kind === 'error' ? 'alert' : 'status'}
      className={cn(
        'mx-2 mb-1 flex items-start gap-1.5 rounded-md bg-muted/50 px-2 py-1.5 text-xs leading-snug',
        kind === 'error' ? 'text-destructive' : 'text-muted-foreground',
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          'mt-0.5 size-3.5 shrink-0',
          kind === 'reconnecting' && 'animate-spin motion-reduce:animate-none',
        )}
      />
      <span className="min-w-0">{children}</span>
    </span>
  );
}
