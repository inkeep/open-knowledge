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
import { requestDocPanelTab } from '@/components/doc-panel-events';
import {
  FileTargetMenuItems,
  type FileTargetMenuPrimitives,
} from '@/components/FileTargetMenuItems';
import { FileTreeFilteredToZeroNotice } from '@/components/FileTreeFilteredToZeroNotice';
import {
  EXCALIDRAW_FILE_ICON_VIEWBOX,
  MARKDOWN_FILE_ICON_VIEWBOX,
} from '@/components/file-entry-icon';
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
import { createFileTreeStyle, FILE_TREE_DENSITY_OPTIONS } from '@/components/file-tree-density';
import { applyExtensionBadges } from '@/components/file-tree-extension-badge';
import {
  AGENT_DECORATION_ICON_ID,
  EXCALIDRAW_FILE_ICON_ID,
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
  OK_PROBLEM_BADGE_ATTR,
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
import { OK_FILE_TREE_READONLY_UNSAFE_CSS } from '@/components/file-tree-shared';
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
import { RestartServerButton } from '@/components/RestartServerButton';
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
    } catch {}
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

const FILE_TREE_CREATION_CLEARED_ATTR = 'data-ok-creation-cleared';
const FILE_TREE_CREATION_CLEARED_CSS = `
  :host([${FILE_TREE_CREATION_CLEARED_ATTR}]) [data-item-focused="true"] {
    --trees-focus-ring-color: transparent;
  }
`;

const FILE_TREE_UNSAFE_CSS = [
  OK_FILE_TREE_READONLY_UNSAFE_CSS,
  FILE_TREE_PROBLEM_CSS,
  FILE_TREE_RENAME_INPUT_CSS,
  FILE_TREE_ROOT_DROP_CSS,
  FILE_TREE_EXTERNAL_FILE_DROP_CSS,
  FILE_TREE_CREATION_CLEARED_CSS,
].join('\n');

interface PendingCreate {
  kind: 'file' | 'folder';
  renamePath: string;
  createdPath: string;
  previousHash: string;
  disposeCommitListener: () => void;
}

type PendingCreateCleanupIntent = 'discard' | 'detach';

interface PendingCreateCleanupOptions {
  intent: PendingCreateCleanupIntent;
}

function assertNeverCleanupIntent(intent: never): never {
  throw new Error(`Unhandled pending-create cleanup intent: ${String(intent)}`);
}

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

interface TrashFailureRequest {
  failed: TrashFailedTarget[];
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
  onCreateFromTemplate: (parentDir: string, templateName: string) => void;
  onDuplicate: (target: FileTreeTarget) => void;
  onImportTemplate: (target: FileTreeTarget, deleteSource: boolean) => void;
  onDelete: (targets: FileTreeTarget[]) => void;
  onExpandSubtree: (treePath: string) => void;
  onCollapseSubtree: (treePath: string) => void;
  folderTreePaths: readonly string[];
  isAsset: boolean;
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
  startCreatingFromTemplate(parentDir: string): void;
  createFromTemplate(parentDir: string, templateName: string): void;
  expandAll(): void;
  collapseAll(): void;
  getFolderState(): { folderCount: number; expandedCount: number };
  isCreationTargetCleared(): boolean;
  subscribe(listener: () => void): () => void;
}

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
  const couldNotReachServerTitle = t`Could not reach server`;
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
      couldNotReachServerTitle,
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
  const [trashFailure, setTrashFailure] = useState<TrashFailureRequest | null>(null);
  const { conflicts: activeConflicts } = useConflicts();
  const [newItemRequest, setNewItemRequest] = useState<{ parentDir: string } | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [creationDirCleared, setCreationDirCleared] = useState(false);
  const creationDirClearedRef = useRef(creationDirCleared);
  const handleListenersRef = useRef<Set<() => void>>(new Set());

  const documentsRef = useRef(documents);
  const pageMetaRef = useRef(pageMeta);
  const pendingExactFileSelectionRef = useRef<string | null>(null);
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
    notifySidebarFileSelected();
  }
  function activateTreePath(
    treePath: string,
    entries: readonly FileEntry[] = documents,
  ): 'doc' | 'non-doc' | 'none' {
    const action = resolveFileTreeSelectionAction(treePath, entries);
    if (action.kind === 'none') {
      console.debug(
        '[FileTree] Dropped selection for unknown docName:',
        treePathToAppPath(treePath),
      );
      return 'none';
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
      return 'non-doc';
    }
    if (action.kind === 'folder') {
      navigateWithPulse({ kind: 'folder', folderPath: action.path });
      return 'non-doc';
    }
    const docEntry = entries.find(
      (item): item is DocumentEntry => isDocumentEntry(item) && item.docName === action.path,
    );
    const okTarget = okContentNavigationTarget(action.path, {
      pages,
      docExt: docEntry?.docExt,
    });
    if (okTarget?.kind === 'asset') {
      openTarget(okTarget, previewOpenOptions);
      pushHashWithoutNavigation(hashFromAssetPath(okTarget.assetPath));
      notifySidebarFileSelected();
      return 'non-doc';
    }
    if (okTarget?.kind === 'doc') {
      navigateWithPulse({ kind: 'doc', docName: okTarget.docName });
      return 'doc';
    }
    navigateWithPulse({
      kind: 'doc',
      docName: action.path,
      size: docEntry?.size,
      registerPage: hasSupportedDocumentExtension(action.path),
    });
    return 'doc';
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
        excalidraw: {
          name: EXCALIDRAW_FILE_ICON_ID,
          viewBox: EXCALIDRAW_FILE_ICON_VIEWBOX,
        },
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
      if (model.getItem(canonicalTreePath) == null) {
        model.move(toDocName, canonicalTreePath);
      }
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
      if (!res.ok && res.status !== 404) {
        const kind = pending.kind;
        const createdPath = pending.createdPath;
        const parsed = await parseServerResponse(res, t`Failed to clean up pending ${kind}`);
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
    treePathsSignature,
  );

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
        setCreationDirCleared(false);
        const selectedTreePath = normalizeSelectionPath(selected);
        const pendingExactFileSelection = pendingExactFileSelectionRef.current;
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

  const problemIndicatorsEnabled = merged?.validation?.fileTreeIndicators !== false;
  const openProblemsForTreePath = useEffectEvent(
    (treePath: string, source: 'pointer' | 'keyboard') => {
      if (activateTreePath(treePath) !== 'doc') return;
      requestDocPanelTab('problems', {
        scope: 'doc',
        focus: source === 'keyboard' ? 'panel' : undefined,
      });
    },
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: i18n.locale is an intentional re-run trigger, not a value the body reads; the strings it controls are written inside applyProblemIndicators.
  useEffect(() => {
    if (loading || documents.length === 0) return;
    const shadow = fileTreeHostRef.current?.querySelector(FILE_TREE_TAG_NAME)?.shadowRoot;
    if (!shadow) return;
    if (!problemIndicatorsEnabled) {
      applyProblemIndicators(shadow, new Map());
      return;
    }
    const apply = () =>
      applyProblemIndicators(shadow, getValidationSnapshot(), openProblemsForTreePath);
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
  }, [loading, documents.length, problemIndicatorsEnabled, i18n.locale]);

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
    if (failedCleanups.length === trashed.length && trashed.length > 0) {
      return null;
    }
    return { deletedDocNames, deletedFolderPaths };
  }

  async function handleDeleteTargets(targets: FileTreeTarget[]) {
    const deleteTargets = targets
      .filter((target) => !hasOkPathSegment(target.path))
      .map((target) => canonicalizeAssetTargetForDelete(target, documentsRef.current));
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

  useEffect(() => {
    return subscribeToFileTreeMenuActionDelete((target) => {
      const fileTreeTarget = fileTreeTargetFromNavigationTarget(target, documentsRef.current);
      if (fileTreeTarget) {
        if (!hasOkPathSegment(fileTreeTarget.path)) {
          setDeleteRequest({ targets: [fileTreeTarget] });
        }
        return;
      }
      warnUnsupportedMenuTarget('delete', target);
    });
  }, []);

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

    if (eventPathHasProblemBadge(event.nativeEvent)) return;

    const item = findTreeItemElement(event.nativeEvent);
    if (!item) {
      if (clickIsInTreeContentArea(event.nativeEvent)) {
        setCreationDirCleared(true);
      }
      return;
    }
    if (item.dataset.fileTreeStickyRow === 'true') return;

    const wasSelected = item.getAttribute('aria-selected') === 'true';

    const rawPath = item.dataset.itemPath;
    if (!rawPath) return;

    const path =
      item.dataset.itemType === 'folder' ? folderPathToTreeDirectoryPath(rawPath) : rawPath;

    if (item.dataset.itemType === 'folder') {
      const folderPath = treeDirectoryPathToFolderPath(path);
      if (wasSelected) {
        if (model.getSelectedPaths().length !== 1) return;
        if (isSameHash(window.location.hash, hashFromFolderPath(folderPath))) return;
      }
      queueMicrotask(() => navigateWithPulse({ kind: 'folder', folderPath }));
      return;
    }

    if (!wasSelected) {
      if (
        hasSameStemMarkdownSiblingTreePath(path, treePathsRef.current) ||
        hasSameStemMarkdownSiblingRendered(path)
      ) {
        pendingExactFileSelectionRef.current = path;
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

  function handleTreeDoubleClickCapture(event: ReactMouseEvent<HTMLElement>) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
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

  const reconnectNotice = reconnecting
    ? relaunchInFlight
      ? t`Relaunching to install the update…`
      : t`Reconnecting…`
    : null;
  const serverUnreachable = error === couldNotReachServerTitle;

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
        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-8">
          <span role="alert" className="select-none text-sidebar-foreground/50 text-sm">
            {error}
          </span>
          {serverUnreachable ? <RestartServerButton /> : null}
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
                  error && (
                    <>
                      <FileTreeHeaderNotice kind="error">{error}</FileTreeHeaderNotice>
                      {}
                      {serverUnreachable ? <RestartServerButton className="mx-2 mb-1" /> : null}
                    </>
                  )
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

function eventPathHasProblemBadge(event: MouseEvent): boolean {
  for (const entry of event.composedPath()) {
    if (entry instanceof HTMLElement && entry.hasAttribute(OK_PROBLEM_BADGE_ATTR)) {
      return true;
    }
  }
  return false;
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
