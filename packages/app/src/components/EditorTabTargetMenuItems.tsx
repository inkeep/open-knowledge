import { Trans, useLingui } from '@lingui/react/macro';
import { toast } from 'sonner';
import {
  FileTargetMenuItems,
  type FileTargetMenuPrimitives,
} from '@/components/FileTargetMenuItems';
import { buildOkignorePatternFromTarget } from '@/components/file-tree-okignore';
import { hasOkPathSegment } from '@/components/file-tree-utils';
import { OpenInAgentEmptySpaceSubmenu } from '@/components/handoff/OpenInAgentEmptySpaceSubmenu';
import { useHandoffDispatch } from '@/components/handoff/useHandoffDispatch';
import { useInstalledAgents } from '@/components/handoff/useInstalledAgents';
import type { ResolvedNavigationTarget } from '@/components/navigation-targets';
import {
  appendPattern,
  parseOkignoreDoc,
  serializeOkignoreDoc,
} from '@/components/settings/okignore-doc';
import { TemplateMenuRows } from '@/components/template-menu-rows';
import {
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu';
import { useGitSyncStatusDetailed } from '@/hooks/use-git-sync-status';
import { useConfigContext } from '@/lib/config-provider';
import { emitCreateTopLevelFile } from '@/lib/create-file-events';
import {
  buildSendToAiInputForActiveTarget,
  resolveActiveTargetRelativePath,
} from '@/lib/file-menu-target-resolvers';
import {
  emitFileTreeMenuActionDelete,
  emitFileTreeMenuActionDuplicate,
  emitFileTreeMenuActionImportTemplate,
} from '@/lib/file-tree-menu-action-events';
import { revealInFileManagerLabel } from '@/lib/reveal-label';
import { scheduleClipboardWrite } from '@/lib/share/clipboard-adapter';
import {
  buildDocShareInput,
  buildFolderShareInput,
  runShareAction,
  type ShareTargetInput,
} from '@/lib/share/run-share-action';
import { useWorkspace } from '@/lib/use-workspace';
import { joinWorkspacePath } from '@/lib/workspace-paths';

export type EditorTabFileTarget = Extract<
  ResolvedNavigationTarget,
  { kind: 'asset' | 'doc' | 'folder' }
>;

const CONTEXT_FILE_TARGET_MENU_PRIMITIVES = {
  Group: ContextMenuGroup,
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubContent: ContextMenuSubContent,
  SubTrigger: ContextMenuSubTrigger,
} satisfies FileTargetMenuPrimitives;

function relativePathForTarget(target: EditorTabFileTarget, docExt?: string): string {
  if (target.kind !== 'doc' || /\.(md|mdx)$/i.test(target.docName)) {
    return resolveActiveTargetRelativePath(target);
  }
  return `${target.docName}${docExt ?? '.md'}`;
}

function shareInputForTarget(target: EditorTabFileTarget): ShareTargetInput | null {
  if (target.kind === 'asset') return null;
  if (target.kind === 'folder') return buildFolderShareInput(target.folderPath);
  return buildDocShareInput(target.docName);
}

function okignoreTargetForTarget(
  target: EditorTabFileTarget,
  docExt?: string,
): Parameters<typeof buildOkignorePatternFromTarget>[0] | null {
  if (target.kind === 'doc') return { kind: 'file', path: target.docName, docExt };
  if (target.kind === 'folder') return { kind: 'folder', path: target.folderPath };
  return null;
}

interface EditorTabTargetMenuItemsProps {
  docExt?: string;
  target: EditorTabFileTarget;
  onRename: () => void;
}

export function EditorTabTargetMenuItems({
  docExt,
  target,
  onRename,
}: EditorTabTargetMenuItemsProps) {
  const { t } = useLingui();
  const workspace = useWorkspace();
  const { okignoreBinding } = useConfigContext();
  const { status: gitSyncStatus } = useGitSyncStatusDetailed();
  const installStates = useInstalledAgents().states;
  const { dispatch } = useHandoffDispatch();
  const relativePath = relativePathForTarget(target, docExt);
  const isManaged = hasOkPathSegment(relativePath);
  const isAsset = target.kind === 'asset';
  const isFolder = target.kind === 'folder';
  const bridge = typeof window !== 'undefined' ? window.okDesktop : undefined;
  const handoffInput = isAsset ? null : buildSendToAiInputForActiveTarget(target, workspace);
  const shareInput = shareInputForTarget(target);
  const canShare = gitSyncStatus?.hasRemote === true && shareInput !== null;
  const okignoreTarget = okignoreTargetForTarget(target, docExt);

  function copyPath(path: string, successMessage: string, errorMessage: string) {
    void scheduleClipboardWrite(path)
      .then(() => toast.success(successMessage, { description: path }))
      .catch((error: unknown) => {
        console.warn('[EditorTabTargetMenuItems] clipboard write failed:', error);
        toast.error(errorMessage);
      });
  }

  function shareTarget() {
    if (!shareInput) return;
    void runShareAction(
      {
        ...shareInput,
        hasRemote: true,
        onClickWhenNoRemote: () => toast.error(t`Connect this project to GitHub to share.`),
      },
      {
        clipboardWrite: scheduleClipboardWrite,
        toastSuccess: (message) => toast.success(message),
        toastError: (message) => toast.error(message),
        logEvent: (message) => console.log(message),
      },
    );
  }

  function hideTarget() {
    if (!okignoreBinding || !okignoreTarget) return;
    const doc = parseOkignoreDoc(okignoreBinding.current());
    const updated = appendPattern(doc, buildOkignorePatternFromTarget(okignoreTarget));
    if (updated === doc) return;
    okignoreBinding.patch(serializeOkignoreDoc(updated));
    const basename = relativePath.split('/').pop() ?? relativePath;
    toast.success(isFolder ? t`Hidden folder “${basename}”` : t`Hidden “${basename}”`, {
      description: t`Manage hidden files in Settings → Ignore patterns.`,
      duration: 5000,
    });
  }

  const revealLabel = revealInFileManagerLabel(bridge?.platform ?? 'linux');
  const noWorkspaceHint = workspace ? null : t`No workspace`;
  const fullPath = workspace
    ? joinWorkspacePath(workspace.contentDir, relativePath, workspace.pathSeparator)
    : '';

  return (
    <FileTargetMenuItems
      primitives={CONTEXT_FILE_TARGET_MENU_PRIMITIVES}
      workspaceReady={workspace !== null}
      folderCreate={
        isFolder && !isManaged
          ? {
              onNewFile: () => emitCreateTopLevelFile({ initialDir: target.folderPath }),
              onNewFolder: () =>
                emitCreateTopLevelFile({ initialDir: target.folderPath, kind: 'folder' }),
              templateItems: (
                <TemplateMenuRows
                  parentDir={target.folderPath}
                  onSelectTemplate={(templateName) =>
                    emitCreateTopLevelFile({
                      template: { folder: target.folderPath, name: templateName },
                    })
                  }
                  ItemComponent={ContextMenuItem}
                />
              ),
            }
          : undefined
      }
      reveal={
        bridge
          ? {
              label: revealLabel,
              ariaLabel: noWorkspaceHint ? `${revealLabel}, ${noWorkspaceHint}` : revealLabel,
              disabled: !workspace,
              hint: noWorkspaceHint,
              onSelect: () => {
                if (!workspace) return;
                void bridge.shell.showItemInFolder(fullPath);
              },
            }
          : undefined
      }
      openWithAi={
        isAsset ? undefined : (
          <OpenInAgentEmptySpaceSubmenu
            input={handoffInput}
            installStates={installStates}
            dispatch={dispatch}
          />
        )
      }
      share={canShare ? { onSelect: shareTarget } : undefined}
      onCopyFullPath={() => {
        if (!workspace) return;
        copyPath(fullPath, t`Copied full path`, t`Could not copy full path`);
      }}
      onCopyRelativePath={() =>
        copyPath(relativePath, t`Copied relative path`, t`Could not copy relative path`)
      }
      onImportTemplate={
        target.kind === 'doc' && !isManaged
          ? (deleteSource) => emitFileTreeMenuActionImportTemplate(target, deleteSource)
          : undefined
      }
      onDuplicate={
        !isAsset && !isManaged ? () => emitFileTreeMenuActionDuplicate(target) : undefined
      }
      onRename={!isManaged ? onRename : undefined}
      hide={
        okignoreTarget && !isManaged
          ? {
              label: isFolder ? <Trans>Hide folder</Trans> : <Trans>Hide this file</Trans>,
              disabled: okignoreBinding === null,
              onSelect: hideTarget,
            }
          : undefined
      }
      onDelete={!isManaged ? () => emitFileTreeMenuActionDelete(target) : undefined}
    />
  );
}
