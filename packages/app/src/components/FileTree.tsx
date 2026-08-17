// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import {
  CreateFolderSuccessSchema,
  CreatePageSuccessSchema,
  DeletePathSuccessSchema,
  DuplicatePathSuccessSchema,
  type HandoffOutcome,
  type HandoffTarget,
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
import { Info, RefreshCw, TriangleAlert } from 'lucide-react';
import { useTheme } from 'next-themes';
import {
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type Ref,
  startTransition,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import { DeleteConfirmationDialog } from '@/components/DeleteConfirmationDialog';
import {
  FileTargetMenuItems,
  type FileTargetMenuPrimitives,
} from '@/components/FileTargetMenuItems';
import { FileTreeFilteredToZeroNotice } from '@/components/FileTreeFilteredToZeroNotice';
import { MARKDOWN_FILE_ICON_VIEWBOX } from '@/components/file-entry-icon';
import {
  appendSidebarUploadFields,
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
  treeFilePathToDocumentDocName,
  treeItemToTarget,
  treePathSignature,
  treePathToAppPath,
  uploadedPathForSidebarDrop,
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
import {
  AGENT_DECORATION_ICON_ID,
  FILE_TREE_DECORATION_SPRITE_SHEET,
  LINK_DECORATION_ICON_ID,
  MARKDOWN_FILE_ICON_ID,
} from '@/components/file-tree-icon-sprite';
import { buildOkignorePatternFromTarget } from '@/components/file-tree-okignore';
import {
  applyDeleteToDocuments,
  applyDuplicateToDocuments,
  applyRenameToDocuments,
  buildRenamedNodePath,
  buildTrashAbsPath,
  canonicalizeAssetTargetForDelete,
  type FileTreeTarget,
  type RenamedAssetMapping,
  type RenamedDocExtensionMapping,
  type RenamedDocMapping,
  type RenamedFolderMapping,
  remapActiveDocName,
} from '@/components/file-tree-operations';
import {
  alternateMarkdownTreePath,
  buildRowDecorationIndex,
  collectTabsToCloseForDelete,
  deleteTargetCoversPendingCreate,
  hasSameStemMarkdownSiblingTreePath,
  isAgentTreePath,
  isEditableKeyboardTarget,
  markdownTreeExtension,
  parseAlreadyExistsRenamePath,
  resolveDuplicableKeyboardTarget,
  resolveKeyboardDeleteTargets,
  selectedTreePathsToDeleteTargets,
} from '@/components/file-tree-path-helpers';
import {
  applyProblemIndicators,
  FILE_TREE_PROBLEM_CSS,
} from '@/components/file-tree-problem-indicators';
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
  previewTabIdForTreePath,
  resolveFileTreeSelection,
  resolveFileTreeSelectionAction,
} from '@/components/file-tree-selection';
import { FILE_TREE_USER_NAME_DIRECTION_CSS } from '@/components/file-tree-shared';
import { selectTrashConfirmCopy, trashTargetDisplayName } from '@/components/file-tree-trash-copy';
import {
  classifyEmptyTree,
  type DocumentEntry,
  type FileEntry,
  hasOkPathSegment,
  isAssetEntry,
  isDocumentEntry,
  isFolderEntry,
} from '@/components/file-tree-utils';
import { NewItemDialog } from '@/components/NewItemDialog';
import {
  largeFileNavigationTarget,
  okContentNavigationTarget,
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
import { AlertDialog } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { asDirectoryHandle, useSelectionMirror } from '@/components/use-selection-mirror';
import { getEditorForDoc } from '@/editor/active-editor';
import { type OpenTargetOptions, useDocumentContext } from '@/editor/DocumentContext';
import { assetTabId, docTabId, folderTabId, remapPathForFolderRenames } from '@/editor/editor-tabs';
import { previewOpenDisposition } from '@/editor/preview-open-disposition';
import { requestPreviewTabPromotionForTab } from '@/editor/preview-tab-promotion';
import { useConflicts } from '@/hooks/use-conflicts';
import { useFolderConfig } from '@/hooks/use-folder-config';
import { useGitSyncStatusDetailed } from '@/hooks/use-git-sync-status';
import { useConfigContext } from '@/lib/config-provider';
import {
  hashFromAssetPath,
  hashFromDocName,
  hashFromFolderPath,
  isSameHash,
  pushHashWithoutNavigation,
} from '@/lib/doc-hash';
import { emitDocumentsChanged } from '@/lib/documents-events';
import {
  subscribeToFileTreeMenuActionDelete,
  subscribeToFileTreeMenuActionDuplicate,
  subscribeToFileTreeMenuActionImportTemplate,
  subscribeToFileTreeMenuActionRename,
} from '@/lib/file-tree-menu-action-events';
import { importTemplate } from '@/lib/folder-config-api';
import { isOverlayLayerOpen } from '@/lib/overlay-layers';
import { parseServerResponse, parseSuccessOrWarn } from '@/lib/parse-server-response';
import { revealInFileManagerLabel, trashNounLabel } from '@/lib/platform-labels';
import { scheduleClipboardWrite } from '@/lib/share/clipboard-adapter';
import {
  buildDocShareInput,
  buildFolderShareInput,
  runShareAction,
  type ShareTargetInput,
} from '@/lib/share/run-share-action';
import {
  hasSidebarDragType,
  OK_SIDEBAR_DRAG_MIME,
  serializeSidebarDragPayload,
} from '@/lib/sidebar-drag';
import { cn } from '@/lib/utils';
import { getValidationSnapshot, subscribeToValidationStore } from '@/lib/validation-store';
import { joinWorkspacePath } from '@/lib/workspace-paths';
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
import { useFileTreeListing } from './use-file-tree-listing';

function focusEditorAfterRename(docName: string): void {
  window.requestAnimationFrame(() => {
    const editor = getEditorForDoc(docName);
    if (!editor || editor.isDestroyed) return;
    try {
      editor.commands.focus();
    } catch {
      // Editor view may be mid-transition; focus is best-effort.
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

// Module-level functions can't call `useLingui()`, so this file uses the
// `@lingui/core/macro` `t` (and `plural`) for any localizable string outside a
// React component; the `t` from `useLingui()` is used inside components.
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

function fileTreeTargetFromNavigationTarget(
  target: ResolvedNavigationTarget,
  documents: readonly FileEntry[],
  documentPath: 'doc-name' | 'tree-path' = 'doc-name',
): FileTreeTarget | null {
  if (target.kind === 'doc' || target.kind === 'folder-index') {
    const docEntry = documents.find(
      (entry): entry is DocumentEntry => isDocumentEntry(entry) && entry.docName === target.docName,
    );
    const path =
      documentPath === 'tree-path'
        ? docNameToTreePath(target.docName, docEntry?.docExt)
        : target.docName;
    return {
      kind: 'file',
      path,
      name: path.split('/').pop() ?? path,
      docExt: docEntry?.docExt,
    };
  }
  if (target.kind === 'folder') {
    return {
      kind: 'folder',
      path: target.folderPath,
      name: target.folderPath.split('/').pop() ?? target.folderPath,
    };
  }
  if (target.kind === 'asset') {
    return {
      kind: 'asset',
      path: target.assetPath,
      name: target.assetPath.split('/').pop() ?? target.assetPath,
    };
  }
  return null;
}

function warnUnsupportedMenuTarget(
  action: 'delete' | 'duplicate' | 'rename',
  target: ResolvedNavigationTarget,
): void {
  console.warn(
    JSON.stringify({
      event: `file-tree-menu-action-${action}-unsupported-kind`,
      kind: target.kind,
    }),
  );
}

// Drop-to-root affordance. The patched `@pierre/trees` sets
// `data-file-tree-root-drag-target="true"` on the virtualized root while an
// in-tree drag hovers empty content area (or a top-level file) — i.e. when the
// drop would promote the dragged item to the project root. The library has no
// row to highlight for a root target, so we paint a container-level ring + tint
// here. An `::after` overlay (not `outline`) is required: the root carries an
// inline `outline: none` that a stylesheet rule can't beat without `!important`,
// and the opaque virtualized-list child would cover an inset box-shadow on the
// root itself. `pointer-events: none` keeps the overlay out of drop hit-testing.
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

// When the creation target is cleared (empty-space click), the active row is
// deselected but Pierre keeps it DOM-focused (roving focus restores focus to
// its focused row, so blurring it doesn't stick) — leaving a lingering focus
// ring. The host carries `data-ok-creation-cleared` while cleared; neutralize
// the ring color on the focused row so the row reads as fully deselected. The
// ring redraws the instant a row is selected or navigation re-couples (the
// attribute drops). `:host([…])` matches the attribute the React wrapper
// forwards onto the `<file-tree-container>` host.
const FILE_TREE_CREATION_CLEARED_ATTR = 'data-ok-creation-cleared';
const FILE_TREE_CREATION_CLEARED_CSS = `
  :host([${FILE_TREE_CREATION_CLEARED_ATTR}]) [data-item-focused="true"] {
    --trees-focus-ring-color: transparent;
  }
`;

// Pierre's per-extension icon color (specificity 0,1,0 on the inner [data-icon-token]
// element) wins over the inherited selected-fg color from the parent row, so the
// markdown icon stays gray when its row is selected. The full styling block lives
// alongside the badge-injection processor in file-tree-extension-badge.ts so the
// CSS + DOM-mutation contract stays in one place.
const FILE_TREE_UNSAFE_CSS = `${FILE_TREE_EXT_BADGE_CSS}\n${FILE_TREE_PROBLEM_CSS}\n${FILE_TREE_RENAME_INPUT_CSS}\n${FILE_TREE_ROOT_DROP_CSS}\n${FILE_TREE_EXTERNAL_FILE_DROP_CSS}\n${FILE_TREE_CREATION_CLEARED_CSS}\n${FILE_TREE_INDENT_GUIDE_CSS}\n${FILE_TREE_STICKY_HEADER_CSS}\n${FILE_TREE_USER_NAME_DIRECTION_CSS}`;

interface PendingCreate {
  kind: 'file' | 'folder';
  renamePath: string;
  createdPath: string;
  previousHash: string;
  disposeCommitListener: () => void;
}

// How a pending create is torn down. 'discard' deletes the just-created path
// from disk — the user cancelled the inline rename, or the create failed.
// 'detach' only releases the in-memory bookkeeping and leaves the file on
// disk: a FileTree unmount, including the error-boundary teardown that fires
// after an app-shell crash, is not a retraction of the create, so it must
// never delete.
type PendingCreateCleanupIntent = 'discard' | 'detach';

interface PendingCreateCleanupOptions {
  intent: PendingCreateCleanupIntent;
}

function assertNeverCleanupIntent(intent: never): never {
  throw new Error(`Unhandled pending-create cleanup intent: ${String(intent)}`);
}

// Observable, non-UI failure channel for a pending-create cleanup. A detach
// (FileTree unmount / error-boundary teardown) has no surviving UI to show a
// failed cleanup, and a discard's toast can die with a crashing tree, so every
// cleanup failure also reports here at console.error — captured in the crash
// bundle, distinct from ordinary console.warn — with the kind and path needed
// to find a file that may still be on disk. Reporting is never gated on
// caller intent, so suppressing UI can never again suppress failure reporting.
function reportPendingCreateCleanupFailure(
  kind: PendingCreate['kind'],
  path: string,
  cause: unknown,
): void {
  console.error('[FileTree] pending-create cleanup failed', { kind, path, cause });
}

interface FileTreeDeleteRequest {
  targets: FileTreeTarget[];
}

/**
 * Per-target state retained across a failed Trash IPC so the
 * `TrashFailureModal` can offer Retry — re-runs Step 1 against the original
 * targets — and Delete Permanently — calls today's `POST /api/delete-path`
 * hard-delete against the targets that failed.
 *
 * The full original target shape is preserved (not just the path) so the
 * fallback hard-delete + tab-close cascade has the same data shape today's
 * single-step delete uses. Cancel dismisses without action; the user's
 * editor tabs are still open (tab-close only fires after a successful Step 1
 * trash).
 */
interface TrashFailureRequest {
  failed: TrashFailedTarget[];
  /** Originals — re-fed to Retry; failed targets re-fed to Delete Permanently. */
  originalTargets: FileTreeTarget[];
}

interface WorkspaceInfo {
  contentDir: string;
  pathSeparator: '/' | '\\';
}

const DROPDOWN_FILE_TARGET_MENU_PRIMITIVES = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubContent: DropdownMenuSubContent,
  SubTrigger: DropdownMenuSubTrigger,
} satisfies FileTargetMenuPrimitives;

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
  onStartCreating: (kind: 'file' | 'folder', parentDir: string) => void;
  /** Inline create-from-template for the given parent dir + template name —
   *  same inline-rename fast path as `onStartCreating`, seeded from a template.
   *  Drives the folder menu's "New from template" hover submenu. */
  onCreateFromTemplate: (parentDir: string, templateName: string) => void;
  onDuplicate: (target: FileTreeTarget) => void;
  onImportTemplate: (target: FileTreeTarget, deleteSource: boolean) => void;
  onDelete: (targets: FileTreeTarget[]) => void;
  onExpandSubtree: (treePath: string) => void;
  onCollapseSubtree: (treePath: string) => void;
  /**
   * Folder tree paths used to hide the subtree Expand/Collapse-All items
   * when their action would be a no-op — mirrors the toolbar's Tree View
   * Options dropdown (FileSidebar.tsx). Iterated through the same predicate
   * `expandSubtree`/`collapseSubtree` use so the visibility matches the
   * action surface exactly.
   */
  folderTreePaths: readonly string[];
  isAsset: boolean;
  /** Authoritative document list — sourced for `docExt` when Pierre's tree
   *  path has lost its extension after a basename-only commit. See `treeItemToTarget`. */
  documents: readonly FileEntry[];
}

function FileTreeMenu({
  item,
  context,
  anyActionBusy,
  workspace,
  handoff,
  model,
  okignoreBinding,
  onStartCreating,
  onCreateFromTemplate,
  onDuplicate,
  onImportTemplate,
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
  const isOkRow = hasOkPathSegment(item.path);
  const okignoreTarget = target.kind === 'asset' ? null : target;
  const canHide = okignoreTarget !== null && okignoreBinding !== null;
  const hideLabel = isFolder ? t`Hide folder` : t`Hide this file`;
  const folderPath = isFolder ? treeDirectoryPathToFolderPath(item.path) : null;
  const folderConfig = useFolderConfig(folderPath);
  const folderHasTemplates =
    folderConfig.state.status === 'ready'
      ? (folderConfig.state.data.folder.templates_available?.length ?? 0) > 0
      : true;
  const selectedTreePaths = model.getSelectedPaths();
  const selectedDeleteTargets = selectedTreePaths.includes(target.treePath)
    ? selectedTreePathsToDeleteTargets(selectedTreePaths, documents)
    : [];
  const deleteTargets = selectedDeleteTargets.length > 1 ? selectedDeleteTargets : [target];
  const deleteLabel = plural(deleteTargets.length, { one: 'Delete', other: 'Delete # items' });
  const relativePath = relativePathForTreeItem(item);
  let handoffInput: HandoffDispatchInput | null = null;
  if (isFolder) {
    handoffInput = buildFolderHandoffInput({ folderRelativePath: relativePath, workspace });
  } else if (!isAsset) {
    handoffInput = buildHandoffInput({
      docName: treeFilePathToDocumentDocName(item.path, documents),
      workspace,
    });
  }
  const closeForInlineSurface = () => context.close({ restoreFocus: false });
  const close = () => context.close();

  const { status: gitSyncStatus } = useGitSyncStatusDetailed();
  const hasRemote = gitSyncStatus?.hasRemote === true;
  let shareInput: ShareTargetInput | null = null;
  if (isFolder) {
    shareInput = buildFolderShareInput(folderPath ?? '');
  } else if (!isAsset && target.kind !== 'asset') {
    shareInput = buildDocShareInput(treeFilePathToDocumentDocName(item.path, documents));
  }
  const canShare = hasRemote && shareInput !== null;

  function handleShare() {
    if (!shareInput) return;
    void runShareAction(
      {
        ...shareInput,
        hasRemote,
        onClickWhenNoRemote: () => {
          toast.error(t`Connect this project to GitHub to share.`);
        },
      },
      {
        clipboardWrite: scheduleClipboardWrite,
        toastSuccess: (msg) => toast.success(msg),
        toastError: (msg) => toast.error(msg),
        logEvent: (msg) => console.log(msg),
      },
    );
  }

  let subtreeFolderCount = 0;
  let subtreeExpandedCount = 0;
  if (isFolder) {
    const root = folderPathToTreeDirectoryPath(item.path);
    for (const candidate of folderTreePaths) {
      if (candidate === root || candidate.startsWith(root)) {
        subtreeFolderCount++;
        if (asDirectoryHandle(model.getItem(candidate))?.isExpanded()) {
          subtreeExpandedCount++;
        }
      }
    }
  }
  const showSubtreeExpandAll = isFolder && subtreeExpandedCount < subtreeFolderCount;
  const showSubtreeCollapseAll = isFolder && subtreeExpandedCount > 0;
  const bridge = typeof window !== 'undefined' ? window.okDesktop : undefined;
  const revealHint = !workspace ? t`No workspace` : null;
  const revealLabel = bridge ? revealInFileManagerLabel(bridge.platform) : null;
  const revealAriaLabel = revealLabel && revealHint ? `${revealLabel}, ${revealHint}` : revealLabel;

  function hideTarget() {
    if (!okignoreBinding || !okignoreTarget) return;
    close();
    const pattern = buildOkignorePatternFromTarget(okignoreTarget);
    const current = okignoreBinding.current();
    const doc = parseOkignoreDoc(current);
    const updated = appendPattern(doc, pattern);
    if (updated === doc) return;
    okignoreBinding.patch(serializeOkignoreDoc(updated));
    const basename = okignoreTarget.path.split('/').pop() || okignoreTarget.path;
    toast.success(isFolder ? t`Hidden folder “${basename}”` : t`Hidden “${basename}”`, {
      description: t`Manage hidden files in Settings → Ignore patterns.`,
      duration: 5000,
    });
  }

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
        <FileTargetMenuItems
          busy={anyActionBusy}
          deleteLabel={deleteLabel}
          primitives={DROPDOWN_FILE_TARGET_MENU_PRIMITIVES}
          workspaceReady={workspace != null}
          folderCreate={
            isFolder && !isOkRow && folderPath != null
              ? {
                  onNewFile: () => {
                    closeForInlineSurface();
                    onStartCreating('file', folderPath);
                  },
                  onNewFolder: () => {
                    closeForInlineSurface();
                    onStartCreating('folder', folderPath);
                  },
                  templateItems: folderHasTemplates ? (
                    <TemplateMenuRows
                      parentDir={folderPath}
                      onSelectTemplate={(templateName) => {
                        closeForInlineSurface();
                        onCreateFromTemplate(folderPath, templateName);
                      }}
                      ItemComponent={DropdownMenuItem}
                    />
                  ) : undefined,
                }
              : undefined
          }
          reveal={
            bridge
              ? {
                  label: revealLabel,
                  ariaLabel: revealAriaLabel ?? undefined,
                  disabled: !workspace,
                  hint: revealHint,
                  onSelect: () => {
                    if (!workspace) return;
                    close();
                    const full = joinWorkspacePath(
                      workspace.contentDir,
                      relativePath,
                      workspace.pathSeparator,
                    );
                    void bridge.shell.showItemInFolder(full);
                  },
                }
              : undefined
          }
          openWithAi={
            isAsset ? undefined : (
              <OpenInAgentContextSubmenu
                input={handoffInput}
                installStates={handoff.installStates}
                isElectronHost={handoff.isElectronHost}
                dispatch={handoff.dispatch}
                onBeforeLaunch={close}
              />
            )
          }
          share={
            canShare
              ? {
                  onSelect: () => {
                    close();
                    handleShare();
                  },
                }
              : undefined
          }
          onCopyFullPath={() => {
            if (!workspace) return;
            close();
            const full = joinWorkspacePath(
              workspace.contentDir,
              relativePath,
              workspace.pathSeparator,
            );
            void copyToClipboard(full, 'full');
          }}
          onCopyRelativePath={() => {
            close();
            void copyToClipboard(relativePath, 'relative');
          }}
          folderTree={
            isFolder
              ? {
                  onExpandAll: showSubtreeExpandAll
                    ? () => {
                        close();
                        onExpandSubtree(item.path);
                      }
                    : undefined,
                  onCollapseAll: showSubtreeCollapseAll
                    ? () => {
                        close();
                        onCollapseSubtree(item.path);
                      }
                    : undefined,
                }
              : undefined
          }
          onImportTemplate={
            !isFolder && !isAsset && !isOkRow
              ? (deleteSource) => {
                  close();
                  onImportTemplate(target, deleteSource);
                }
              : undefined
          }
          onDuplicate={
            !isAsset && !isOkRow
              ? () => {
                  close();
                  onDuplicate(target);
                }
              : undefined
          }
          onRename={
            !isOkRow
              ? () => {
                  closeForInlineSurface();
                  model.startRenaming(item.path);
                }
              : undefined
          }
          hide={
            !isOkRow && okignoreTarget
              ? { label: hideLabel, disabled: !canHide, onSelect: hideTarget }
              : undefined
          }
          onDelete={
            !isOkRow
              ? () => {
                  close();
                  onDelete(deleteTargets);
                }
              : undefined
          }
        />
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
  /**
   * Snapshot of the tree's folder state, cheap to call on every render.
   * Reads `folderTreePathsRef.current` for `folderCount` and iterates
   * `model.getItem(path)?.isExpanded()` for `expandedCount`. FileSidebar
   * subscribes (`subscribe` + this getter) to smart-hide the Expand/
   * Collapse-all commands across its menu surfaces when their action
   * would be a no-op.
   */
  getFolderState(): { folderCount: number; expandedCount: number };
  /**
   * Whether the user has cleared the creation target by clicking the tree's
   * empty space. When true, FileSidebar routes New file / New folder to the
   * project root instead of the active item's folder. Re-couples to the active
   * item on the next navigation.
   */
  isCreationTargetCleared(): boolean;
  /**
   * Subscribe to changes that affect `getFolderState()` — folder list
   * mutations from `/api/documents` polling AND per-folder expand/
   * collapse from the Pierre tree model — and to `isCreationTargetCleared()`.
   * Returns an unsubscribe.
   */
  subscribe(listener: () => void): () => void;
}

/**
 * Must be mounted inside a `SidebarProvider` — `useSidebar()` throws otherwise.
 * Today only `FileSidebar` mounts it, which is always inside the provider.
 */
export function FileTree({ ref }: { ref?: Ref<FileTreeHandle | null> }) {
  const { t, i18n } = useLingui();
  const {
    activeDocName,
    activeTarget,
    closeTabs,
    closeDocument,
    isNewTabActive,
    openTarget,
    prewarm,
    reconcileLocalRemoval,
    reconcileLocalRename,
    setSkillsSidebar,
  } = useDocumentContext();
  const { notifySidebarFileSelected } = useSidebar();
  const { resolvedTheme } = useTheme();
  const { addPage, pageMeta, pages } = usePageList();
  const { okignoreBinding, merged } = useConfigContext();
  const showHiddenFiles = merged?.appearance?.sidebar?.showHiddenFiles ?? false;
  const showOnlyMarkdownFiles = merged?.appearance?.sidebar?.showOnlyMarkdownFiles ?? false;
  const showOkFolders = merged?.appearance?.sidebar?.showOkFolders ?? false;
  const previewTabsEnabled = merged?.editor?.previewTabs ?? true;
  const previewOpenOptions = {
    disposition: previewOpenDisposition(previewTabsEnabled),
    consumeActiveNewTab: true,
  } satisfies OpenTargetOptions;
  const {
    documents,
    setDocuments,
    recordOptimisticAdd,
    loading,
    error,
    setError,
    reconnecting,
    relaunchInFlight,
    truncatedShownCount,
    unfilteredRootEntryCount,
    observeExpandedFolderPaths,
  } = useFileTreeListing({
    showHiddenFiles,
    showOnlyMarkdownFiles,
    showOkFolders,
    messages: {
      fallbackErrorTitle: t`Failed to load documents`,
      schemaMismatchTitle: t`Documents response did not match expected shape.`,
      couldNotReachServerTitle: t`Could not reach server`,
    },
  });
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
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [deleteRequest, setDeleteRequest] = useState<FileTreeDeleteRequest | null>(null);
  const [templateConvertRequest, setTemplateConvertRequest] = useState<FileTreeTarget | null>(null);
  /**
   * Set when `shell.trashItem` returns `{ ok: false }` for one or more
   * targets during the Step 1 trash flow. Drives the rendering of
   * `TrashFailureModal`. Cleared on Cancel; cleared on Delete Permanently /
   * Retry after the follow-up flow completes.
   */
  const [trashFailure, setTrashFailure] = useState<TrashFailureRequest | null>(null);
  // Tracks the project-level conflict list so delete/move-to-trash can refuse
  // up front when a target (or any child of a target folder) is conflicted.
  // The HTTP `handleDeletePath` already gates conflicts; the Electron Move-
  // to-Trash flow does NOT (Step 1 is `shell.trashItem`, an OS call), so we
  // refuse here before the file leaves disk.
  const { conflicts: activeConflicts } = useConflicts();
  // Sibling to startCreating's inline-rename UX: opens NewItemDialog when
  // the user picks "New from template…" from a folder context menu, so the
  // template picker is reachable without giving up the fast typed-name
  // path that the toolbar / first-row create still uses.
  const [newItemRequest, setNewItemRequest] = useState<{ parentDir: string } | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  // Clicking the tree's empty content area "deselects" the active row *for
  // creation purposes only*: New file / New folder land at the project root
  // instead of next to the open doc, while the editor keeps showing whatever
  // was open (activeTarget is untouched). When set, `activeTreePath` resolves
  // to null so `useSelectionMirror` drops the row highlight; it re-couples the
  // moment the active target changes (open a row / navigate elsewhere) or the
  // user selects another row. FileSidebar reads this via the imperative handle
  // to route the create parent dir to ''.
  const [creationDirCleared, setCreationDirCleared] = useState(false);
  const creationDirClearedRef = useRef(creationDirCleared);
  // Imperative-handle subscribers (FileSidebar) that need to react to
  // `creationDirCleared` changes — Pierre's `model.subscribe` only fires on
  // tree-model mutations, not React state, so the handle multiplexes both.
  const handleListenersRef = useRef<Set<() => void>>(new Set());

  const documentsRef = useRef(documents);
  const pageMetaRef = useRef(pageMeta);
  const pendingExactFileSelectionRef = useRef<string | null>(null);
  // Single navigation path for tree-initiated opens: resolve the target per
  // kind, open it in the active tab, sync the hash, and pulse the sidebar.
  function navigateWithPulse(
    target:
      | { kind: 'doc'; docName: string; size?: number; registerPage?: boolean }
      | { kind: 'folder'; folderPath: string }
      | { kind: 'asset'; assetPath: string; entries?: readonly FileEntry[] },
  ) {
    if (target.kind === 'doc') {
      if (target.registerPage) addPage(target.docName);
      openTarget(navigationTargetForDocument(target.docName, target.size), previewOpenOptions);
      pushHashWithoutNavigation(hashFromDocName(target.docName));
    } else if (target.kind === 'folder') {
      openTarget(
        { kind: 'folder', target: target.folderPath, folderPath: target.folderPath },
        previewOpenOptions,
      );
      pushHashWithoutNavigation(hashFromFolderPath(target.folderPath));
    } else {
      const currentEntries = target.entries ?? documentsRef.current;
      const entry = currentEntries.find(
        (item): item is Extract<FileEntry, { kind: 'asset' }> =>
          isAssetEntry(item) && item.path === target.assetPath,
      );
      openTarget(
        {
          kind: 'asset',
          target: target.assetPath,
          assetPath: target.assetPath,
          mediaKind: entry?.mediaKind ?? null,
        },
        previewOpenOptions,
      );
      pushHashWithoutNavigation(hashFromAssetPath(target.assetPath));
    }
    // Opening from the Files tree KEEPS you in Files, even when the thing you
    // opened is a skill's file. Surface follows the target only when the
    // navigation came from outside a tree (a deep link, the palette) and so
    // carries no surface intent of its own — clicking a row in a tree carries
    // plenty. Must run after `openTarget`: committing a new tab re-arms
    // autofollow, and this is the pin that overrides it.
    setSkillsSidebar(false);
    notifySidebarFileSelected();
  }
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
        previewOpenOptions,
      );
      pushHashWithoutNavigation(action.hash);
      notifySidebarFileSelected();
      return;
    }
    if (action.kind === 'folder') {
      navigateWithPulse({ kind: 'folder', folderPath: action.path });
      return;
    }
    const docEntry = entries.find(
      (item): item is DocumentEntry => isDocumentEntry(item) && item.docName === action.path,
    );
    // Revealed `.ok` document rows never open the raw create-mode editor. The
    // shared routing returns null for the sanctioned content docs — template
    // leaves (matched by shape, so a freshly-created template that lags the page
    // index still routes right) and indexed skill docs (matched by page-list
    // membership) — which fall through to the editable doc open below; every
    // other `.ok` file resolves to the read-only text viewer. Same rule the hash
    // resolver's doc-open guard applies.
    const okTarget = okContentNavigationTarget(action.path, {
      pages,
      docExt: docEntry?.docExt,
    });
    if (okTarget?.kind === 'asset') {
      openTarget(okTarget, previewOpenOptions);
      pushHashWithoutNavigation(hashFromAssetPath(okTarget.assetPath));
      notifySidebarFileSelected();
      return;
    }
    if (okTarget?.kind === 'doc') {
      navigateWithPulse({ kind: 'doc', docName: okTarget.docName });
      return;
    }
    navigateWithPulse({
      kind: 'doc',
      docName: action.path,
      size: docEntry?.size,
      registerPage: hasSupportedDocumentExtension(action.path),
    });
  }
  const activeDocNameRef = useRef(activeDocName);
  const assetTreePaths = new Set(
    documents.filter(isAssetEntry).map((entry) => fileEntryToTreePath(entry)),
  );
  const assetTreePathsRef = useRef(assetTreePaths);
  const rowDecorationIndex = buildRowDecorationIndex(documents);
  const rowDecorationIndexRef = useRef(rowDecorationIndex);
  const activeAncestorTreePathsRef = useRef<string[]>([]);
  const pendingCreateRef = useRef<PendingCreate | null>(null);
  const cleanupPendingCreateRef = useRef<
    (pending: PendingCreate, options: PendingCreateCleanupOptions) => Promise<void>
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
  const copiedKeyboardTargetRef = useRef<FileTreeTarget | null>(null);
  const observeExpandedFolderPathsRef = useRef<(paths: readonly string[]) => void>(() => {});
  // Pierre reset helpers may run after an awaited mutation, so they read the
  // latest `showOkFolders` setting rather than the render that started it.
  const showOkFoldersRef = useRef<boolean>(false);
  const fileTreeHostRef = useRef<HTMLDivElement | null>(null);
  const handleSelectionChangeRef = useRef<(selectedPaths: readonly string[]) => void>(() => {});
  const handleRenameRef = useRef<(event: FileTreeRenameEvent) => void>(() => {});
  const handleRenameErrorRef = useRef<(message: string) => void>((message) => toast.error(message));
  const handleDropCompleteRef = useRef<(event: FileTreeDropResult) => void>(() => {});
  const activeTargetRef = useRef(activeTarget);
  const [emptyExternalFileDropActive, setEmptyExternalFileDropActive] = useState(false);

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

    function finalizeSidebarDragStart(event: Event) {
      if (!(event instanceof DragEvent)) return;
      if (!hasSidebarDragType(event.dataTransfer)) return;
      // Pierre's row handler runs between these shadow-root phases and resets this to move.
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copyMove';
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
    shadow.addEventListener('dragstart', finalizeSidebarDragStart);
    shadow.addEventListener('dragover', handleExternalFileDragOver, { capture: true });
    shadow.addEventListener('dragleave', handleExternalFileDragLeave, { capture: true });
    shadow.addEventListener('drop', handleExternalFileDrop, { capture: true });
    shadow.addEventListener('dragend', clearSidebarDragInProgressSoon, { capture: true });
    window.addEventListener('drop', clearSidebarDragInProgressSoon, true);
    window.addEventListener('dragend', clearSidebarDragInProgressSoon, true);
    return () => {
      shadow.removeEventListener('dragstart', handleDragStart, { capture: true });
      shadow.removeEventListener('dragstart', finalizeSidebarDragStart);
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
  // When the user has cleared the creation target (empty-space click), drop the
  // row highlight without disturbing the editor. `useSelectionMirror` keys off
  // this null to deselect; the reset effect below re-couples on any nav change.
  const activeTreePath = creationDirCleared ? null : baseActiveTreePath;

  const handoffInstallStates = useInstalledAgents().states;
  const { dispatch: dispatchHandoff } = useHandoffDispatch();
  const handoff = {
    installStates: handoffInstallStates,
    isElectronHost: typeof window !== 'undefined' && window.okDesktop != null,
    dispatch: dispatchHandoff,
  };
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
        const doc = rowDecorationIndexRef.current.docsByTreePath.get(item.path);
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
      // Symlinked directories carry isSymlink on their FolderEntry. Badge the
      // alias folder itself (Finder-style — its contents are not separately
      // marked, since they live behind the one symlink).
      const folder = rowDecorationIndexRef.current.foldersByTreeDirectoryPath.get(
        folderPathToTreeDirectoryPath(item.path),
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
  const folderTreePaths = collectTreeFolderPathsFromDocuments(documents, {
    includeOkFolders: showOkFolders,
  });
  const folderTreePathsRef = useRef(folderTreePaths);

  // Keep parents visible without forcing the selected folder itself open.
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
      collectTreeFolderPathsFromDocuments(nextDocuments ?? documentsRef.current, {
        includeOkFolders: showOkFoldersRef.current,
      }),
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

  // Invariant: Pierre's `#focusedPath` and `#selectedPaths` reference paths
  // in `documentsToTreePaths(documents)`. If the user deletes the suffix
  // before committing an inline rename, Pierre can leave the store keyed by
  // the extensionless basename ('bar'), while React documents hold the
  // canonical 'bar.md' / 'bar.png'. Reconcile by moving Pierre's leftover to
  // canonical before the natural `resetPaths` gets suppressed by
  // `markNextDocumentsAsApplied`.
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
      // Positive selector for the extensionless commit condition. Drag/drop
      // + folder-cascade have canonical paths already, so `getItem(toDocName)`
      // returns null and we skip (which also avoids Pierre's `movePath` throw
      // on missing source). Idempotent under React StrictMode double-invocation.
      if (model.getItem(toDocName) == null) continue;
      const destination = next.find(
        (entry): entry is DocumentEntry => isDocumentEntry(entry) && entry.docName === toDocName,
      );
      const canonicalTreePath = docNameToTreePath(toDocName, destination?.docExt ?? source.docExt);
      // `move()` atomically remaps `#focusedPath` AND `#selectedPaths` via
      // `#applyMutationState` — selection reconciliation depends on this.
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
    // Focus is singular — Pierre's commit invariant means at most one
    // extensionless inline rename, so `reconciledCount` is ~always 1.
    // The explicit focus call hedges against `resetPaths` clearing the
    // in-memory focus state (no-op when already focused or absent).
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
          navigateWithPulse({ kind: 'folder', folderPath: success.path });
        } else {
          navigateWithPulse({ kind: 'doc', docName: success.path });
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
    { intent }: PendingCreateCleanupOptions,
  ) {
    clearPendingCreate(pending);

    // A 'detach' releases the pending-create bookkeeping and leaves the file on
    // disk. It is what a FileTree unmount wants — including the error-boundary
    // teardown after an app-shell crash — where deleting the file the user just
    // asked for would be data loss. Only an explicit 'discard' deletes. A new
    // intent must choose its disk behavior here rather than defaulting into the
    // delete path below.
    switch (intent) {
      case 'detach':
        return;
      case 'discard':
        break;
      default:
        return assertNeverCleanupIntent(intent);
    }

    setBusyPath(pending.renamePath);

    try {
      const res = await fetch('/api/delete-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: pending.kind, path: pending.createdPath }),
      });
      // 404 on cleanup is fine — the entry was never persisted server-side.
      // Any other non-2xx is a real failure that needs to surface.
      if (!res.ok && res.status !== 404) {
        const kind = pending.kind;
        const createdPath = pending.createdPath;
        const parsed = await parseServerResponse(res, t`Failed to clean up pending ${kind}`);
        // `parseServerResponse` returns `{ok: false, title}` whenever the
        // upstream `res.ok` is false — the union's success arm is unreachable
        // under this branch. Discriminate explicitly for the type system,
        // and short-circuit the unreachable arm without ceremony.
        if (parsed.ok) return;
        const detail = parsed.title;
        reportPendingCreateCleanupFailure(kind, createdPath, { status: res.status, detail });
        toast.error(t`${detail} - ${kind} "${createdPath}" still exists on disk`);
        setBusyPath(null);
        resetModelToDocuments();
        return;
      }
    } catch (err) {
      const kind = pending.kind;
      const createdPath = pending.createdPath;
      reportPendingCreateCleanupFailure(kind, createdPath, err);
      toast.error(t`Network error - ${kind} "${createdPath}" still exists on disk`);
      setBusyPath(null);
      resetModelToDocuments();
      return;
    }

    if (pending.kind === 'file') {
      closeDocument(pending.createdPath);
    } else {
      closeTabs([folderTabId(pending.createdPath)], { force: true });
    }
    setDocuments((current) => {
      const next = applyDeleteToDocuments(
        current,
        pending.kind === 'file' ? [pending.createdPath] : [],
        pending.kind === 'folder' ? pending.createdPath : undefined,
      );
      markNextDocumentsAsApplied(next);
      return next;
    });
    emitDocumentsChanged(['files', 'backlinks', 'graph']);
    window.location.hash = pending.previousHash;
    setBusyPath(null);
  }

  useEffect(() => {
    return () => {
      const pending = pendingCreateRef.current;
      if (pending) {
        void cleanupPendingCreateRef.current(pending, { intent: 'detach' }).catch((err) => {
          reportPendingCreateCleanupFailure(pending.kind, pending.createdPath, err);
        });
      }
    };
  }, []);

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
    // Re-run trigger: re-assert the active-row selection after the tree is
    // repopulated by `model.resetPaths` (see the reset effect above). Without
    // this, a direct-URL / hash-nav first paint whose `/api/documents` lands
    // AFTER the first mirror commit reveals + expands the row but never
    // selects it (selectedRow count stays 0). Same trigger the reveal-active-
    // row effect already uses.
    treePathsSignature,
  );

  // Re-couple the creation target to the active item whenever navigation moves
  // it — opening a row, following a link, switching tabs. `baseActiveTreePath`
  // is the activeTarget-derived path BEFORE the cleared override, so this fires
  // on real nav changes but NOT when the empty-space click flips `cleared`
  // (which leaves activeTarget untouched). Keeps "clicked empty space" sticky
  // until the user actually navigates again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: setCreationDirCleared is a stable state setter; baseActiveTreePath is the sole trigger.
  useEffect(() => {
    setCreationDirCleared(false);
  }, [baseActiveTreePath]);

  // Bridge `creationDirCleared` (React state) to the imperative handle's
  // subscribers (FileSidebar) — Pierre's model.subscribe doesn't observe React
  // state, so notify the handle listeners explicitly on change.
  useEffect(() => {
    creationDirClearedRef.current = creationDirCleared;
    for (const listener of handleListenersRef.current) listener();
  }, [creationDirCleared]);

  // Scroll the active document's row into view in the virtualized file tree.
  // `useSelectionMirror` (above) selects the row and expands its ancestors but
  // only sets @pierre/trees' *focused index* — Pierre auto-scrolls a focused
  // row into view solely when the tree owns DOM focus, which a programmatic open
  // never gives it, so the row can stay below the fold after opening a doc from
  // a link or switching tabs. Declared after `useSelectionMirror` so it runs
  // after that effect on the same commit (React flushes same-tier effects in
  // declaration order); a layout effect would run before it instead.
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeAncestorTreePathsSignature + treePathsSignature are re-run triggers — the row's visible index shifts when ancestors expand or the tree repopulates.
  useEffect(() => {
    if (loading || !activeTreePath) return;
    revealActiveRow(model, activeTreePath);
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: the subscription reads the latest hook callback through its ref and only the Pierre model controls its lifetime.
  useEffect(() => {
    return model.subscribe(() => {
      observeExpandedFolderPathsRef.current([...collectExpandedFolderTreePaths()]);
    });
  }, [model]);

  useEffect(() => {
    return model.onMutation('remove', (event) => {
      const pending = pendingCreateRef.current;
      if (!pending || event.path !== pending.renamePath) return;
      void cleanupPendingCreateRef.current(pending, { intent: 'discard' });
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

    await reconcileLocalRename({
      renamed,
      renamedFolders,
      renamedAssets,
      additionalRemovedDocNames: [...docToAssetRenames.keys()],
    });
    for (const entry of renamed) {
      addPage(entry.toDocName);
    }
    for (const entry of assetToDocRenames.values()) {
      addPage(entry);
    }

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
      navigateWithPulse({ kind: 'folder', folderPath: nextActiveFolderPath });
    } else if (nextActiveDocName && nextActiveDocName !== currentActiveDocName) {
      navigateWithPulse({ kind: 'doc', docName: nextActiveDocName });
      focusEditorAfterRename(nextActiveDocName);
    } else if (
      nextActiveAssetPath &&
      (activeDocToAssetPath || nextActiveAssetPath !== currentActiveAssetPath)
    ) {
      navigateWithPulse({
        kind: 'asset',
        assetPath: nextActiveAssetPath,
        entries: nextDocumentsForRename ?? documentsRef.current,
      });
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
      // Operate on RAW event paths — `normalizeTreePathForKind` appends `.md`
      // to anything not already ending in `.md` / `.mdx`, which would mask
      // "user changed the extension to .tx" into "user typed weird basename
      // foo.tx and we appended .md".
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
              fromPath: treeFilePathToDocumentDocName(sourceTreePath, documentsRef.current),
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
          await cleanupPendingCreate(pending, { intent: 'discard' });
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
      // Split try/catch: server-side rename already committed
      // (`parsed.ok === true`). A failure inside `applyRenamedDocuments`
      // (IDB clear, tab remap, document-state reconciliation) is a
      // client-side reconciliation failure, NOT a network error.
      // Labeling it "Network error — please try again" would misdirect
      // the user toward a retry that POSTs against a now-nonexistent
      // source path and fails differently. The correct recovery is to
      // refresh and resync with disk truth.
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
        await cleanupPendingCreate(pending, { intent: 'discard' });
      } else {
        clearPendingCreate();
      }
      setBusyPath(null);
    }
  }

  const handleTreeRenameEvent = useEffectEvent(handleTreeRename);

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
        const sourceDocName = sourceIsAsset
          ? null
          : treeFilePathToDocumentDocName(operation.sourcePath, documentsRef.current);
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
                fromPath: sourceDocName ?? treeFilePathToDocName(operation.sourcePath),
                toPath:
                  sourceDocName && hasSupportedDocumentExtension(sourceDocName)
                    ? operation.destinationTreePath
                    : treeFilePathToDocName(operation.destinationTreePath),
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
      appendSidebarUploadFields(formData, parentDir, file.name || 'upload');

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
            recordOptimisticAdd(entry);
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
      // Pierre commits an unchanged inline rename on blur without firing onRename.
      // Treat the default-named item as committed so toolbar/menu creates still work.
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
        // Template param mirrors NewItemDialog's create call: the server seeds
        // the new doc from the named template's body + frontmatter. Omitted for
        // the blank "New file" path so behavior there is unchanged.
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
        // Mirror `applyRenamedDocuments`'s `addPage(entry.toDocName)`: until
        // the `/api/pages` refetch lands (50–500ms), `pages.has(docName)`
        // would otherwise be false and drive `isNewDoc=true` at
        // `EditorActivityPool.tsx`, flipping the composite TipTap key when
        // the refetch resolves and forcing a mid-window remount during the
        // create → inline-rename → click race.
        addPage(docName);
        // Register the optimistic add inside the updater so the
        // duplicate-check early-return path doesn't leak a registry entry
        // for a path we never inserted. See mergeAndPruneRecentLocalAdds.
        setDocuments((current) => {
          if (current.some((entry) => isDocumentEntry(entry) && entry.docName === docName)) {
            return current;
          }
          const next = [...current, newFileEntry];
          markNextDocumentsAsApplied(next);
          recordOptimisticAdd(newFileEntry);
          return next;
        });
        emitDocumentsChanged(['files', 'backlinks', 'graph']);
        navigateWithPulse({ kind: 'doc', docName });
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
          recordOptimisticAdd(newFolderEntry);
          return next;
        });
        emitDocumentsChanged(['files']);
        navigateWithPulse({ kind: 'folder', folderPath: createdPath });
      }

      let disposed = false;
      const handleCommitKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'Enter') return;
        // Unlike its sibling below, this listener has no focus gate — the
        // pending placeholder is its only condition, so an Enter pressed in a
        // layer above would otherwise commit it.
        if (isOverlayLayerOpen()) return;
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
        await cleanupPendingCreate(pending, { intent: 'discard' });
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

  function selectedRenderedTreePath(): string | null {
    const shadow = fileTreeHostRef.current?.querySelector(FILE_TREE_TAG_NAME)?.shadowRoot;
    const selectedRow = shadow?.querySelector<HTMLElement>(
      '[aria-selected="true"][data-item-path]',
    );
    return selectedRow?.dataset.itemPath ?? null;
  }

  useLayoutEffect(() => {
    documentsRef.current = documents;
    rowDecorationIndexRef.current = rowDecorationIndex;
    pageMetaRef.current = pageMeta;
    activeDocNameRef.current = activeDocName;
    activeTargetRef.current = activeTarget;
    assetTreePathsRef.current = assetTreePaths;
    busyPathRef.current = busyPath;
    showOkFoldersRef.current = showOkFolders;
    treePathsRef.current = treePaths;
    folderTreePathsRef.current = folderTreePaths;
    activeAncestorTreePathsRef.current = activeAncestorTreePaths;
    observeExpandedFolderPathsRef.current = observeExpandedFolderPaths;
    cleanupPendingCreateRef.current = cleanupPendingCreate;
    uploadExternalFilesRef.current = (files, parentDir, uploadBusyPath) => {
      void uploadExternalFilesToTarget(files, parentDir, uploadBusyPath);
    };
    handleSelectionChangeRef.current = (selectedPaths) => {
      if (suppressSelectionRef.current || sidebarDragInProgressRef.current) return;
      if (selectedPaths.length !== 1) return;
      const selected = selectedPaths[0];
      if (selected) {
        // Selecting a row re-establishes it as the creation target (the reset
        // effect also catches this once activeTarget commits, but clearing
        // eagerly avoids a one-frame deselected flash on the clicked row).
        setCreationDirCleared(false);
        const selectedTreePath = normalizeSelectionPath(selected);
        const pendingExactFileSelection = pendingExactFileSelectionRef.current;
        // The click handler sets this ref and schedules hash navigation with
        // setTimeout(0); this microtask consumes the exact row first.
        const hasPendingExactFileSelection =
          pendingExactFileSelection !== null &&
          treeFilePathToDocName(pendingExactFileSelection) ===
            treeFilePathToDocName(selectedTreePath);
        const targetTreePath = hasPendingExactFileSelection
          ? pendingExactFileSelection
          : selectedTreePath;
        pendingExactFileSelectionRef.current = null;
        queueMicrotask(() => {
          const renderedTreePath = hasPendingExactFileSelection ? null : selectedRenderedTreePath();
          activateTreePath(
            normalizeSelectionPath(renderedTreePath ?? targetTreePath),
            documentsRef.current,
          );
        });
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
      const isCopy = isPlatformShortcut && !event.shiftKey && key === 'c';
      const isPaste = isPlatformShortcut && !event.shiftKey && key === 'v';
      const isDelete =
        !event.altKey &&
        !event.shiftKey &&
        ((event.metaKey && !event.ctrlKey && key === 'backspace') ||
          (!event.metaKey && !event.ctrlKey && key === 'delete'));
      if (!isSelectAll && !isDuplicate && !isCopy && !isPaste && !isDelete) return;
      if (isEditableKeyboardTarget(event.target)) return;

      const host = fileTreeHostRef.current;
      const target = event.target;
      const activeElement = document.activeElement;
      const eventStartedInTree = target instanceof Node && host?.contains(target);
      const focusIsInTree = activeElement instanceof Node && host?.contains(activeElement);
      if (!eventStartedInTree && !focusIsInTree) return;

      if (isCopy) {
        const copiedTarget = resolveDuplicableKeyboardTarget(
          model,
          documentsRef.current,
          assetTreePathsRef.current,
        );
        if (!copiedTarget) return;
        copiedKeyboardTargetRef.current = copiedTarget;
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (isPaste) {
        const copiedTarget = copiedKeyboardTargetRef.current;
        if (!copiedTarget) return;
        void handleDuplicateTargetRef.current(copiedTarget);
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (isDuplicate) {
        const duplicateTarget = resolveDuplicableKeyboardTarget(
          model,
          documentsRef.current,
          assetTreePathsRef.current,
        );
        if (!duplicateTarget) return;
        void handleDuplicateTargetRef.current(duplicateTarget);
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (isDelete) {
        if (busyPathRef.current !== null) return;
        const targets = resolveKeyboardDeleteTargets(model, documentsRef.current);
        if (targets.length === 0) return;
        setDeleteRequest({ targets });
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

  // `@pierre/trees` renders rows inside an open shadow root and exposes no
  // per-row attribute hook, so the full-path `title` is stamped imperatively
  // here. It must also be stamped on the floating `[data-type=context-menu-anchor]`
  // overlay: @pierre/trees positions that `···` ("Options") trigger over the
  // hovered row's right edge as a *sibling* of the row, not a descendant — so
  // the row's own `title` doesn't resolve when the cursor rests there.
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

  // Replace Pierre's trailing-dot artifact with an always-visible uppercase
  // extension badge. Same shadow-root + MutationObserver pattern as
  // stampTitles above — kept as a separate observer so the watch scope
  // (textual mutations) doesn't widen stampTitles's attribute-only filter.
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

  // Tint + badge rows whose docs have validation problems, from the shared
  // validation store. Same shadow-root + MutationObserver pattern as the
  // extension badge above, plus a store subscription so tint updates arrive
  // without a DOM mutation (e.g. a project audit landing while the tree is
  // idle). Our own attribute writes are outside the `data-item-path` filter
  // and the badge write is value-gated, so the observer stays quiescent.
  const problemIndicatorsEnabled = merged?.validation?.fileTreeIndicators !== false;
  useEffect(() => {
    if (loading || documents.length === 0) return;
    const shadow = fileTreeHostRef.current?.querySelector(FILE_TREE_TAG_NAME)?.shadowRoot;
    if (!shadow) return;
    if (!problemIndicatorsEnabled) {
      // One clearing pass strips any tint/badges left from before the toggle
      // flipped off; no observer or store subscription while disabled.
      applyProblemIndicators(shadow, new Map());
      return;
    }
    const apply = () => applyProblemIndicators(shadow, getValidationSnapshot());
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(shadow, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-item-path'],
    });
    const unsubscribe = subscribeToValidationStore(apply);
    return () => {
      observer.disconnect();
      unsubscribe();
    };
  }, [loading, documents.length, problemIndicatorsEnabled]);

  // Select Pierre's rename-input stem while keeping the extension visible and
  // editable. Kept separate from the badge observer because the watched event
  // (childList: the rename input mounting) is structurally different from the
  // badge's attribute/text watch.
  //
  // `data-item-path` attribute observation is needed for the stale-marker
  // sweep: Pierre's optimistic commit changes the path attribute
  // without a childList ripple, and the disk-truth refresh that restores
  // the extension is also an attribute-only mutation.
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

  // Snapshot cache for getFolderState() — keeps the returned object
  // reference-stable when {folderCount, expandedCount} are unchanged so
  // FileSidebar's `setFolderState(tree.getFolderState())` calls bail
  // out via React's `Object.is` instead of triggering redundant
  // re-renders. Allocates a fresh object only when values genuinely
  // shifted.
  const folderStateCacheRef = useRef<{ folderCount: number; expandedCount: number }>({
    folderCount: 0,
    expandedCount: 0,
  });

  // Stash the inline imperative closures in refs so useImperativeHandle's
  // deps array can stay `[model]` only. Without this, Biome's
  // useExhaustiveDependencies forces those identifiers into the deps and then
  // immediately complains they "change on every re-render" — a no-win box
  // because manual memoization (useCallback / useMemo) is banned in this
  // codebase per CLAUDE.md.
  //
  // Refs are synced in a useEffect (not during render) — React Compiler
  // disallows mutating `.current` during render. Effects run after commit
  // and before paint; by the time the handle methods fire on user
  // interaction (click), the ref is current.
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
        // Read fresh from the model on every call — paths reflect any
        // pending /api/documents update via folderTreePathsRef, isExpanded()
        // reflects pending tree-model mutations from the current frame.
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
      subscribe(listener: () => void) {
        // The Pierre tree model's subscribe fires on ALL tree-state changes:
        // expand, collapse, focus, AND resetPaths (which is invoked from the
        // documents-update effect at the resetPaths call site). One
        // subscription covers both the per-folder expand/collapse path AND
        // the folder-list-changed path that documents-fetched triggers. The
        // local listener set adds `creationDirCleared` (React state) changes,
        // which Pierre's model never observes.
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

  /**
   * Post-delete aftermath shared by both Electron (Step 2) and web
   * (today's HTTP hard-delete). Handles pending-create reconciliation, tab
   * closure, IDB clearing for deleted docNames, tree-model removal, and the
   * documents-state update + change emit. Runs after the deletion source of
   * truth (disk or Trash) has already removed the items — this only mirrors
   * the in-memory + UI state to match.
   */
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
    await reconcileLocalRemoval({
      tabIdsToClose: [
        ...[...deleted].map((docName) => docTabId(docName)),
        ...[...deletedFolders].map((folderPath) => folderTabId(folderPath)),
        ...[...deletedAssets].map((assetPath) => assetTabId(assetPath)),
      ],
      docNamesToClear: [...deleted],
    });

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

  async function executeImportTemplate(target: FileTreeTarget, deleteSource: boolean) {
    if (busyPathRef.current !== null) return;
    const clearBusyState = () => {
      setBusyPath(null);
      busyPathRef.current = null;
      setTemplateConvertRequest(null);
    };
    busyPathRef.current = target.path;
    setBusyPath(target.path);
    setError(null);

    const appPath = target.path;
    const slash = appPath.lastIndexOf('/');
    const targetFolder = slash === -1 ? '' : appPath.slice(0, slash);

    const res = await importTemplate({
      sourcePath: target.path,
      targetFolder,
      deleteSource,
    });

    if (!res.ok) {
      toast.error(t`Failed to import template`, { description: res.error });
      clearBusyState();
      return;
    }

    if (deleteSource) {
      await applyDeleteAftermath([target], [target.path], []);
      // Optimistically remove from view if deleted, standard watcher sweeps later
      setDocuments((current) => {
        const next = current.filter(
          (entry) => !(isDocumentEntry(entry) && entry.docName === target.path),
        );
        resetModelToDocuments(next);
        markNextDocumentsAsApplied(next);
        return next;
      });
      emitDocumentsChanged(['files', 'backlinks', 'graph']);
    }

    toast.success(t`Template imported`, {
      description: res.path,
    });
    clearBusyState();
  }

  async function handleImportTemplate(target: FileTreeTarget, deleteSource: boolean) {
    if (target.kind !== 'file') return;
    if (deleteSource) {
      setTemplateConvertRequest(target);
      return;
    }
    await executeImportTemplate(target, false);
  }

  const handleImportTemplateEvent = useEffectEvent(handleImportTemplate);

  /**
   * Hard-delete via `POST /api/delete-path` — web mode and the Electron
   * fallback path (Delete Permanently from `TrashFailureModal`). Iterates
   * over targets; on per-target failure, applies the aftermath for whatever
   * succeeded so far and surfaces a toast. Returns `true` iff every target
   * deleted cleanly.
   */
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
        // Partial-failure recovery — apply aftermath for what succeeded so
        // the tree stays consistent, then surface the error and bail.
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

  /**
   * Electron-only 2-step Trash flow:
   *   Step 1: `bridge.shell.trashItem(absPath)` — moves the item to ~/.Trash.
   *           Tab close happens AFTER this succeeds — eliminates the
   *           fail-forward UX hazard where the tab would close before the
   *           user knew the trash failed.
   *   Step 2: `POST /api/trash/cleanup` — server runs
   *           `captureAndCloseDocuments` + `recentlyRemovedDocs.setDeleted` +
   *           fileIndex purge + CC1 broadcast. Does NOT touch disk (file is
   *           already in Trash). Threads `extractActorIdentity` per
   *           CLAUDE.md STOP rule.
   *
   * Returns the targets split by per-step outcome. Step 1 failures populate
   * `failed` for the `TrashFailureModal` to render. Step 2 failures surface
   * as a toast since the item IS in the OS Trash — the server-side state
   * will reconcile via the file-watcher eventually.
   */
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
          // Narrow over the IPC wire (different process). A widened bridge
          // contract that adds a new failure reason would otherwise blow
          // through `as TrashFailureReason` and surface an unmapped label.
          reason: coerceTrashFailureReason(result.reason),
          detail: result.detail,
        });
      }
    }
    return { trashed, failed };
  }

  /**
   * Step 2 of the trash flow — POST cleanup for each successfully trashed
   * target. Aggregates the server-reported `deletedDocNames` so the in-memory
   * aftermath uses the same set the server-side index purged.
   *
   * Per-target failures DON'T bail the loop: every successful trashItem (Step
   * 1) deserves its server-side cleanup attempt, and a transient failure on
   * one target shouldn't strand the others' state. Failures get a single
   * aggregated toast at the end + a console.warn per failure; the file-watcher
   * reconciles any state we couldn't push (the file IS already in OS Trash).
   * Returns `null` only when ALL targets failed (so the caller knows to fall
   * back to a local aftermath using just the targets themselves).
   */
  async function postTrashCleanup(
    trashed: readonly FileTreeTarget[],
  ): Promise<{ deletedDocNames: string[]; deletedFolderPaths: string[] } | null> {
    const deletedDocNames: string[] = [];
    const deletedFolderPaths: string[] = [];
    const failedCleanups: Array<{ target: FileTreeTarget; reason: string }> = [];
    for (const target of trashed) {
      const kind = target.kind;
      // Per-iteration try/catch funnels thrown fetch failures (e.g.
      // `TypeError: Failed to fetch` on network loss) into the same
      // `failedCleanups` aggregation path the HTTP-level branch uses,
      // keeping `postTrashCleanup` non-throwing. Without this, a thrown
      // fetch propagates out to `handleDeleteTargets`'s outer catch and
      // shows the misleading "Could not complete delete" toast — but
      // items in `trashed[]` already moved to OS Trash, so the delete
      // DID succeed; only the cleanup notification failed.
      try {
        const res = await fetch('/api/trash/cleanup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind, path: target.path }),
        });
        const parsed = await parseServerResponse(res, t`Failed to clean up after trash`);
        if (!parsed.ok) {
          // Continue the loop — file IS in Trash, the file-watcher will
          // reconcile any server-side state we couldn't push directly. Log
          // the per-target failure so the diagnostic trail names which targets
          // need watcher follow-up; the aggregated toast at the end surfaces
          // a single message to the user rather than N noisy toasts.
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
      const trashNoun = trashNounLabel(
        typeof window !== 'undefined' ? window.okDesktop?.platform : undefined,
      );
      toast.error(
        t`Server-side cleanup failed for ${plural(failedCount, { one: '# item', other: '# items' })}`,
        {
          description: t`The file is in your ${trashNoun}; the file-watcher will reconcile.`,
        },
      );
    }
    // All targets failed → caller falls back to a local aftermath using just
    // the targets (everything is in the OS Trash regardless).
    if (failedCleanups.length === trashed.length && trashed.length > 0) {
      return null;
    }
    return { deletedDocNames, deletedFolderPaths };
  }

  async function handleDeleteTargets(targets: FileTreeTarget[]) {
    // Last chokepoint before side effects: on Electron, `shell.trashItem`
    // moves files to the OS Trash BEFORE the server's reserved-path guard can
    // refuse, so read-only `.ok` targets are dropped here regardless of which
    // entry surface produced them.
    const deleteTargets = targets
      .filter((target) => !hasOkPathSegment(target.path))
      .map((target) => canonicalizeAssetTargetForDelete(target, documentsRef.current));
    const firstTarget = deleteTargets[0];
    if (!firstTarget) return;

    // Refuse if any target (file) or any conflicted child of a target
    // (folder) is in conflict. The HTTP `/api/delete-path` route already
    // refuses with 409 (`urn:ok:error:doc-in-conflict`), but the Electron
    // Move-to-Trash flow goes through `shell.trashItem` first — by the
    // time `/api/trash/cleanup` runs the file is already in OS Trash.
    // Refusing here keeps the source-of-truth gate (server-side) honest
    // and avoids stranding conflicted files in the OS Trash where the
    // sync engine can't see them.
    //
    // Path-shape mismatch trap: `c.file` is extension-FUL (e.g. `foo.md`);
    // `FileTreeTarget.path` for files is extension-LESS (`foo`) with the
    // extension in `t.docExt`. Reconstruct the extension-ful candidate
    // before the equality check, mirroring the server-side
    // `${docName}${getDocExtension(...)}` pattern in handleDeletePath.
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
      const files = sample.join(', ');
      const overflow = blockingConflicts.length - sample.length;
      toast.error(t`Cannot delete files with unresolved conflicts`, {
        description:
          overflow > 0
            ? t`Resolve the conflict on ${files}, +${overflow} more before deleting.`
            : t`Resolve the conflict on ${files} before deleting.`,
      });
      return;
    }

    setBusyPath(firstTarget.path);
    setDeleteRequest(null);

    const bridge = typeof window !== 'undefined' ? window.okDesktop : undefined;
    try {
      if (bridge && workspace) {
        // Electron path: 2-step Trash flow.
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
            // Step 2 failed but Step 1 succeeded — file is in Trash, server
            // will reconcile via file-watcher. Apply local aftermath using
            // the targets themselves so the renderer mirrors the truth on
            // disk (file is gone).
            const localDocNames = trashed.filter((t) => t.kind === 'file').map((t) => t.path);
            const localFolderPaths = trashed.filter((t) => t.kind === 'folder').map((t) => t.path);
            await applyDeleteAftermath(trashed, localDocNames, localFolderPaths);
          }
        }
        if (failed.length > 0) {
          // Surface the trash-failure fallback modal for the failed subset;
          // the successful subset is already committed to the tree.
          setTrashFailure({ failed, originalTargets: [...deleteTargets] });
        }
        setBusyPath(null);
      } else {
        // Web path: today's HTTP hard-delete (no OS Trash in the browser).
        const ok = await hardDeleteTargets(deleteTargets);
        setBusyPath(null);
        if (!ok) resetModelToDocuments();
      }
    } catch (err) {
      // Network is one of many failure modes here: tree-model `model.remove`
      // throws, IDB tab-close persistence errors, the trash IPC link going
      // away mid-flight, an unexpected `fetch` reject. Generic phrasing
      // surfaces the underlying error detail (via the toast description)
      // rather than misattributing every failure as a network error.
      const detail = err instanceof Error ? err.message : String(err);
      console.warn('[FileTree] delete failed:', err);
      toast.error(t`Could not complete delete`, { description: detail });
      setBusyPath(null);
      resetModelToDocuments();
    }
  }

  /**
   * Delete Permanently from `TrashFailureModal` — hard-delete (today's
   * `POST /api/delete-path`) for the targets that failed Step 1. Tabs close
   * + IDB clears via the shared aftermath.
   */
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
      // Mirror the sibling catch — `hardDeleteTargets` shares the same
      // failure-mode surface (model.remove throws, IDB tab-close, fetch
      // reject, …), so the toast generalization applies here too. Surfacing
      // the underlying error detail beats misattributing every failure as
      // network noise.
      const detail = err instanceof Error ? err.message : String(err);
      console.warn('[FileTree] hard-delete fallback failed:', err);
      toast.error(t`Could not complete delete`, { description: detail });
      setBusyPath(null);
      resetModelToDocuments();
    }
  }

  /**
   * Retry from `TrashFailureModal` — re-run Step 1 against the FAILED
   * subset only. Targets that succeeded in the prior attempt are already
   * in the system Trash; replaying them produces fresh `not-found` results
   * (realpath fails for already-trashed items) and re-opens the failure
   * modal listing items the user already disposed of. Filter to the failed
   * targets so Retry actually means "try those specific items again."
   *
   * Compound `${kind}:${path}` key matches `handleTrashFailureDeletePermanently`
   * above — same shape `FileTreeTarget` carries (kind ∪ path) so different
   * target kinds that share the same relative path never alias each other.
   */
  async function handleTrashFailureRetry() {
    if (!trashFailure) return;
    const failedSet = new Set(trashFailure.failed.map((f) => `${f.kind}:${f.path}`));
    const originals = trashFailure.originalTargets.filter((t) =>
      failedSet.has(`${t.kind}:${t.path}`),
    );
    setTrashFailure(null);
    await handleDeleteTargets(originals);
  }

  // Editor tabs and the macOS File menu share this request bus. Convert their
  // navigation target to the row menu's target shape, then open the same
  // confirmation dialog instead of bypassing it for an immediate delete.
  //
  // docExt is looked up from `documentsRef` (the in-memory document list)
  // at fire-time so document trash flow + downstream rename hints render the
  // real `.md` / `.mdx` rather than guessing. Assets remain first-class
  // `kind: 'asset'` targets and share the same delete spine.
  useEffect(() => {
    return subscribeToFileTreeMenuActionDelete((target) => {
      const fileTreeTarget = fileTreeTargetFromNavigationTarget(target, documentsRef.current);
      if (fileTreeTarget) {
        if (!hasOkPathSegment(fileTreeTarget.path)) {
          setDeleteRequest({ targets: [fileTreeTarget] });
        }
        return;
      }
      // missing — File menu's Move to Trash is disabled for this scope
      // upstream; the emit shouldn't fire. Logging the event so a future
      // drift between the menu-enable gate and the emitter is caught.
      warnUnsupportedMenuTarget('delete', target);
    });
  }, []);

  // macOS File menu's `duplicate` item bridges to the same HTTP duplicate
  // spine the row context menu uses. Path resolution mirrors Rename/Delete:
  // doc + folder-index duplicate the file, folder duplicates the folder, and
  // asset + missing are guarded upstream by menu enablement.
  useEffect(() => {
    return subscribeToFileTreeMenuActionDuplicate((target) => {
      const fileTreeTarget = fileTreeTargetFromNavigationTarget(target, documentsRef.current);
      if (fileTreeTarget && fileTreeTarget.kind !== 'asset') {
        void handleDuplicateTargetRef.current(fileTreeTarget);
        return;
      }
      warnUnsupportedMenuTarget('duplicate', target);
    });
  }, []);

  // Menu-bar rename keeps Pierre's inline editor. Tab-menu rename supplies a
  // destination name from its dialog and enters the same handleTreeRename
  // spine directly, so both surfaces share validation and reconciliation.
  useEffect(() => {
    return subscribeToFileTreeMenuActionRename((target, nextName) => {
      const renameTarget = fileTreeTargetFromNavigationTarget(
        target,
        documentsRef.current,
        'tree-path',
      );
      if (!renameTarget) {
        warnUnsupportedMenuTarget('rename', target);
        return;
      }

      if (nextName === undefined) {
        model.startRenaming(renameTarget.path);
        return;
      }
      void handleTreeRenameEvent({
        sourcePath: renameTarget.path,
        destinationPath: buildRenamedNodePath(renameTarget, nextName),
        isFolder: renameTarget.kind === 'folder',
      });
    });
  }, [model]);

  useEffect(() => {
    return subscribeToFileTreeMenuActionImportTemplate((target, deleteSource) => {
      const fileTreeTarget = fileTreeTargetFromNavigationTarget(target, documentsRef.current);
      if (fileTreeTarget?.kind !== 'file') return;
      void handleImportTemplateEvent(fileTreeTarget, deleteSource);
    });
  }, []);

  function cancelCurrentHoverPrewarm() {
    const current = hoveredPrewarmDocRef.current;
    if (current) cancelHoverPrewarm(current);
    hoveredPrewarmDocRef.current = null;
  }

  function hasSameStemMarkdownSiblingRendered(treePath: string): boolean {
    const alternate = alternateMarkdownTreePath(treePath);
    if (!alternate) return false;
    const shadow = fileTreeHostRef.current?.querySelector(FILE_TREE_TAG_NAME)?.shadowRoot;
    if (!shadow) return false;
    for (const row of shadow.querySelectorAll<HTMLElement>('[data-item-path]')) {
      if (row.dataset.itemPath === alternate) return true;
    }
    return false;
  }

  function handleTreeMouseMove(event: ReactMouseEvent<HTMLElement>) {
    const path = findTreeItemPath(event.nativeEvent);
    if (!path || path.endsWith('/')) {
      cancelCurrentHoverPrewarm();
      return;
    }
    const entry = documentsRef.current.find((item) => fileEntryToTreePath(item) === path);
    if (entry && isAssetEntry(entry)) {
      cancelCurrentHoverPrewarm();
      return;
    }
    const docName =
      entry && isDocumentEntry(entry)
        ? entry.docName
        : treeFilePathToDocumentDocName(path, documentsRef.current);
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

    // Pierre only emits selection changes when the selected path changes.
    // If app navigation lags behind the selected row, a plain click on that
    // already-selected row still needs to activate the row's target.
    const item = findTreeItemElement(event.nativeEvent);
    if (!item) {
      // Plain click on the tree's empty content area (no row) deselects the
      // active row for creation purposes — New file / New folder then land at
      // the project root. The editor view is untouched. Gated to the scroll
      // region so clicks on the header / search chrome don't trigger it.
      if (clickIsInTreeContentArea(event.nativeEvent)) {
        setCreationDirCleared(true);
      }
      return;
    }
    // The pinned folder-header overlay renders a second element for the same
    // row: it carries `data-item-path` but no `aria-selected`, so the folder
    // branch below would read every click on it as a first click and re-expand
    // instead of collapsing. Pierre's own sticky click handling collapses the
    // folder and scrolls the canonical row back into view, which is the whole
    // gesture, so stay out of its way.
    if (item.dataset.fileTreeStickyRow === 'true') return;

    const wasSelected = item.getAttribute('aria-selected') === 'true';

    const rawPath = item.dataset.itemPath;
    if (!rawPath) return;

    const path =
      item.dataset.itemType === 'folder' ? folderPathToTreeDirectoryPath(rawPath) : rawPath;

    if (item.dataset.itemType === 'folder') {
      const folderPath = treeDirectoryPathToFolderPath(path);
      // A folder click is never swallowed. Pierre's own row handler is what
      // toggles the row, and it treats the whole row (chevron, icon, label,
      // empty space) as one hit target. Stopping the event here to expand the
      // folder by hand made collapsing impossible on any row that was not
      // already the selected one — the state every click on a child document
      // leaves behind.
      //
      // Navigation is additive rather than a second toggle, and neither of the
      // two ancestor-expanding mechanisms reopens the row this click closed:
      // `useSelectionMirror` and the model subscription below both expand
      // `activeAncestorTreePaths`, and that list never contains the active
      // folder itself (`computeTreeAncestorPaths` returns strict ancestors, and
      // the `selectedFolderPath` branch additionally drops its last segment).
      // The clicked folder becomes the active target, so it leaves its own
      // ancestor list. The ordering that matters — the collapse happening
      // before navigation commits, while the stale ancestor ref still names
      // this folder — is pinned end to end by the "stays collapsed after the
      // navigation settles" assertion in
      // `tests/stress/file-tree-collapse-spaced-folder.e2e.ts`.
      if (wasSelected) {
        if (model.getSelectedPaths().length !== 1) return;
        // Already on this folder's page: nothing left to navigate to.
        if (isSameHash(window.location.hash, hashFromFolderPath(folderPath))) return;
      }
      queueMicrotask(() => navigateWithPulse({ kind: 'folder', folderPath }));
      return;
    }

    if (!wasSelected) {
      // Lazy/show-all model state can lag rows that already rendered, so the
      // DOM query is the fallback for same-stem markdown sibling detection.
      if (
        hasSameStemMarkdownSiblingTreePath(path, treePathsRef.current) ||
        hasSameStemMarkdownSiblingRendered(path)
      ) {
        pendingExactFileSelectionRef.current = path;
        // Let handleSelectionChange's microtask consume the exact file selection
        // before navigation commits the extension-qualified URL.
        setTimeout(() => navigateWithPulse({ kind: 'doc', docName: path, registerPage: true }), 0);
        return;
      }
      queueMicrotask(() => activateTreePath(path));
      return;
    }
    const docName = treeFilePathToDocumentDocName(path, documentsRef.current);
    if (model.getSelectedPaths().length !== 1) return;
    if (isSameHash(window.location.hash, hashFromDocName(docName))) return;
    queueMicrotask(() => activateTreePath(path));
  }

  /**
   * Double-clicking a row commits to that file, so its preview tab stops being
   * provisional — matching double-click on the tab itself.
   *
   * Deliberately additive: the row was already opened by the first click of the
   * pair, so this only flips the tab's preview state and never navigates. That
   * keeps it clear of the click-capture handler's folder-expand and
   * same-stem-sibling paths, which is why it doesn't preventDefault.
   *
   * Folders are skipped. A double-click on one is two toggles of its expand
   * state — a gesture about the tree, not a commitment to the folder overview.
   */
  function handleTreeDoubleClickCapture(event: ReactMouseEvent<HTMLElement>) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    // The inline rename input is a descendant of the row and inherits its
    // `data-item-path`, so a double-click to select a word while renaming would
    // otherwise read as a commit to the row. Same helper the tree's keydown
    // handler uses for the same reason.
    if (isEditableKeyboardTarget(event.target)) return;
    const item = findTreeItemElement(event.nativeEvent);
    if (!item || item.dataset.fileTreeStickyRow === 'true') return;
    if (item.dataset.itemType === 'folder') return;
    const tabId = previewTabIdForTreePath(item.dataset.itemPath, documentsRef.current, pages);
    if (tabId) requestPreviewTabPromotionForTab(tabId);
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

  // Calm reconnect copy shown in place of the red "Could not reach server"
  // error while the listing is silently re-attempted across a relaunch's full
  // lifecycle: "Relaunching…" while the relaunch is in flight, and (after an
  // aborted relaunch clears `relaunchInFlight` while a retry is still settling)
  // the honest "Reconnecting…".
  const reconnectNotice = reconnecting
    ? relaunchInFlight
      ? t`Relaunching to install the update…`
      : t`Reconnecting…`
    : null;

  if (documents.length === 0) {
    // The empty tree is the most likely state during a relaunch (zero docs
    // while the server is down), so both notices carry their live-region role
    // here too — matching `FileTreeHeaderNotice` on the populated path.
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
    if (
      classifyEmptyTree({
        visibility: { showHiddenFiles, showOnlyMarkdownFiles },
        unfilteredRootEntryCount,
        knownPageCount: pages.size,
      }) === 'filtered-to-zero'
    ) {
      return <FileTreeFilteredToZeroNotice />;
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
  // Sidebar files come from the disk walk, not the search index, so the
  // guidance must not point at search. Under lazy depth-1 loading the cap
  // applies per fetched level, so the count describes the truncated folder's
  // level — not the whole tree, which can legitimately show more rows than
  // the count.
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
          // Forwarded onto the <file-tree-container> host; drives the
          // focus-ring suppression in FILE_TREE_CREATION_CLEARED_CSS.
          {...{ [FILE_TREE_CREATION_CLEARED_ATTR]: creationDirCleared ? '' : undefined }}
          onClickCapture={handleTreeClickCapture}
          onDoubleClickCapture={handleTreeDoubleClickCapture}
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
              onStartCreating={startCreating}
              onCreateFromTemplate={(parentDir, templateName) =>
                startCreating('file', parentDir, { template: templateName })
              }
              onDuplicate={handleDuplicateTarget}
              onImportTemplate={handleImportTemplate}
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
      <AlertDialog
        open={!!deleteRequest}
        onOpenChange={(open) => {
          if (!open && !busyPath) setDeleteRequest(null);
        }}
      >
        {deleteRequest && primaryDeleteTarget && (
          <DeleteConfirmationDialog
            // Trash flow on Electron uses VSCode-verbatim copy;
            // web mode (no OS Trash) keeps today's hard-delete copy.
            {...(() => {
              const variant: 'electron' | 'web' =
                typeof window !== 'undefined' && window.okDesktop != null ? 'electron' : 'web';
              const copy = selectTrashConfirmCopy(
                variant,
                deleteRequest.targets,
                typeof window !== 'undefined' ? window.okDesktop?.platform : undefined,
              );
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
              // Web mode — preserve today's copy.
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
      </AlertDialog>
      <AlertDialog
        open={!!templateConvertRequest}
        onOpenChange={(open) => {
          if (!open && !busyPath) setTemplateConvertRequest(null);
        }}
      >
        {templateConvertRequest && (
          <DeleteConfirmationDialog
            itemName={
              templateConvertRequest.name +
              (templateConvertRequest.kind === 'file'
                ? (templateConvertRequest.docExt ?? '.md')
                : '.md')
            }
            customTitle={t`Convert to template`}
            customDescription={t`Are you sure you want to convert this file into a template? The original file will be deleted. This action cannot be undone.`}
            customConfirmLabel={t`Convert`}
            customConfirmLabelBusy={t`Converting...`}
            isSubmitting={busyPath !== null}
            onDelete={() => executeImportTemplate(templateConvertRequest, true)}
          />
        )}
      </AlertDialog>
      <AlertDialog
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
      </AlertDialog>
      <NewItemDialog
        open={newItemRequest !== null}
        onOpenChange={(open) => {
          if (!open) setNewItemRequest(null);
        }}
        kind="file"
        initialDir={newItemRequest?.parentDir ?? ''}
        // This dialog is only opened via `startCreatingFromTemplate` (the
        // native macOS File → "New from Template…" item), so default the
        // picker to the first resolved template rather than Blank note.
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

// True when the click landed inside the tree's scrollable content region (the
// row list + its empty area below the last row), as opposed to the header /
// search chrome. Same `[data-file-tree-virtualized-scroll]` anchor the
// drag-to-root patch uses, reached via composedPath because the tree renders
// in a shadow root.
function clickIsInTreeContentArea(event: MouseEvent): boolean {
  for (const entry of event.composedPath()) {
    if (entry instanceof HTMLElement && entry.matches('[data-file-tree-virtualized-scroll]')) {
      return true;
    }
  }
  return false;
}

// Cold-start sidebar fallback. Mimics the row shape of the file tree (chevron
// + icon affordance + label) so the sidebar feels intentional during the
// `ready`-gated `/api/documents` round-trip rather than flashing the prior
// "No files yet" empty-state CTA. Widths are varied to read as a real list.
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

/**
 * Contained notice row for the tree header slot: icon + text in a muted
 * rounded box. `error` renders an assertive `role="alert"` with a warning
 * icon and destructive tone; `info` renders a polite `role="status"` (the
 * Show All truncation affordance); `reconnecting` renders a polite
 * `role="status"` with a spinning icon and muted tone (the desktop-relaunch
 * self-heal notice). Keep children non-interactive — the row is an aria-live
 * region, and focusable descendants inside one diverge from what screen
 * readers announce.
 */
function FileTreeHeaderNotice({
  kind,
  children,
}: {
  kind: 'error' | 'info' | 'reconnecting';
  children: ReactNode;
}) {
  const Icon = kind === 'error' ? TriangleAlert : Info;
  const iconClassName = 'mt-0.5 size-3.5 shrink-0';
  return (
    <span
      role={kind === 'error' ? 'alert' : 'status'}
      className={cn(
        'mx-2 mb-1 flex items-start gap-1.5 rounded-md bg-muted/50 px-2 py-1.5 text-xs leading-snug',
        kind === 'error' ? 'text-destructive' : 'text-muted-foreground',
      )}
    >
      {kind === 'reconnecting' ? (
        <Spinner aria-hidden="true" icon={RefreshCw} className={iconClassName} />
      ) : (
        <Icon aria-hidden="true" className={iconClassName} />
      )}
      <span className="min-w-0">{children}</span>
    </span>
  );
}
