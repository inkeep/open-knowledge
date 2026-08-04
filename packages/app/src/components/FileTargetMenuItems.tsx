import { Trans } from '@lingui/react/macro';
import {
  Copy,
  CopyPlus,
  EyeOff,
  FileKey,
  FilePlus,
  FolderOpen,
  FolderPlus,
  FoldVertical,
  Pencil,
  Share2,
  SquarePen,
  Trash2,
  UnfoldVertical,
} from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';

interface MenuItemProps {
  children?: ReactNode;
  disabled?: boolean;
  onSelect?: () => void;
  variant?: 'default' | 'destructive';
  'aria-label'?: string;
  'data-testid'?: string;
}

interface MenuContainerProps {
  children?: ReactNode;
  className?: string;
}

function MenuGroupFallback({ children }: MenuContainerProps) {
  return children;
}

export interface FileTargetMenuPrimitives {
  Group?: ComponentType<MenuContainerProps>;
  Item: ComponentType<MenuItemProps>;
  Separator: ComponentType;
  Sub: ComponentType<MenuContainerProps>;
  SubContent: ComponentType<MenuContainerProps>;
  SubTrigger: ComponentType<MenuItemProps>;
}

interface RevealAction {
  label: ReactNode;
  ariaLabel?: string;
  disabled?: boolean;
  hint?: ReactNode;
  onSelect: () => void;
}

interface FolderCreateActions {
  onNewFile: () => void;
  onNewFolder: () => void;
  templateItems?: ReactNode;
}

interface FolderTreeActions {
  onExpandAll?: () => void;
  onCollapseAll?: () => void;
}

interface HideAction {
  label: ReactNode;
  disabled?: boolean;
  onSelect: () => void;
}

export interface FileTargetMenuItemsProps {
  busy?: boolean;
  deleteLabel?: ReactNode;
  folderCreate?: FolderCreateActions;
  folderTree?: FolderTreeActions;
  hide?: HideAction;
  openWithAi?: ReactNode;
  primitives: FileTargetMenuPrimitives;
  reveal?: RevealAction;
  share?: { onSelect: () => void };
  onCopyFullPath: () => void;
  onCopyRelativePath: () => void;
  onDelete?: () => void;
  onDuplicate?: () => void;
  onImportTemplate?: (deleteSource: boolean) => void;
  onRename?: () => void;
  workspaceReady: boolean;
}

/**
 * Target actions shared by file-tree rows and editor tabs. Callers supply the
 * matching Radix primitive family so one action definition can live inside a
 * DropdownMenu or ContextMenu without detaching keyboard navigation.
 */
export function FileTargetMenuItems({
  busy = false,
  deleteLabel,
  folderCreate,
  folderTree,
  hide,
  openWithAi,
  primitives,
  reveal,
  share,
  onCopyFullPath,
  onCopyRelativePath,
  onDelete,
  onDuplicate,
  onImportTemplate,
  onRename,
  workspaceReady,
}: FileTargetMenuItemsProps) {
  const { Item, Separator, Sub, SubContent, SubTrigger } = primitives;
  const Group = primitives.Group ?? MenuGroupFallback;
  const hasTreeActions = folderTree?.onExpandAll != null || folderTree?.onCollapseAll != null;
  const hasMutationActions =
    onImportTemplate != null ||
    onDuplicate != null ||
    onRename != null ||
    hide != null ||
    onDelete != null;

  return (
    <>
      {folderCreate ? (
        <>
          <Group>
            <Item disabled={busy} onSelect={folderCreate.onNewFile}>
              <SquarePen aria-hidden="true" />
              <Trans>New file</Trans>
            </Item>
            {folderCreate.templateItems ? (
              <Sub>
                <SubTrigger disabled={busy}>
                  <FilePlus aria-hidden="true" />
                  <Trans>New from template</Trans>
                </SubTrigger>
                <SubContent>
                  <Group>{folderCreate.templateItems}</Group>
                </SubContent>
              </Sub>
            ) : null}
            <Item disabled={busy} onSelect={folderCreate.onNewFolder}>
              <FolderPlus aria-hidden="true" />
              <Trans>New folder</Trans>
            </Item>
          </Group>
          <Separator />
        </>
      ) : null}

      <Group>
        {reveal ? (
          <Item disabled={reveal.disabled} onSelect={reveal.onSelect} aria-label={reveal.ariaLabel}>
            <FolderOpen aria-hidden="true" />
            <span className="flex-1">{reveal.label}</span>
            {reveal.hint ? (
              <span aria-hidden="true" className="ml-2 text-muted-foreground text-xs">
                {reveal.hint}
              </span>
            ) : null}
          </Item>
        ) : null}
        {openWithAi}
        {share ? (
          <Item data-testid="file-tree-menu-share" onSelect={share.onSelect}>
            <Share2 aria-hidden="true" />
            <Trans>Share</Trans>
          </Item>
        ) : null}
        <Sub>
          <SubTrigger>
            <Copy aria-hidden="true" />
            <Trans>Copy path</Trans>
          </SubTrigger>
          <SubContent>
            <Group>
              <Item disabled={!workspaceReady} onSelect={onCopyFullPath}>
                <Trans>Full path</Trans>
              </Item>
              <Item onSelect={onCopyRelativePath}>
                <Trans>Relative path</Trans>
              </Item>
            </Group>
          </SubContent>
        </Sub>
      </Group>

      {hasTreeActions ? (
        <>
          <Separator />
          <Group>
            {folderTree?.onExpandAll ? (
              <Item onSelect={folderTree.onExpandAll}>
                <UnfoldVertical aria-hidden="true" />
                <Trans>Expand all</Trans>
              </Item>
            ) : null}
            {folderTree?.onCollapseAll ? (
              <Item onSelect={folderTree.onCollapseAll}>
                <FoldVertical aria-hidden="true" />
                <Trans>Collapse all</Trans>
              </Item>
            ) : null}
          </Group>
        </>
      ) : null}

      {hasMutationActions ? (
        <>
          <Separator />
          <Group>
            {onImportTemplate ? (
              <Sub>
                <SubTrigger disabled={busy}>
                  <FileKey aria-hidden="true" />
                  <Trans>Import as template</Trans>
                </SubTrigger>
                <SubContent>
                  <Group>
                    <Item disabled={busy} onSelect={() => onImportTemplate(false)}>
                      <Trans>Keep original file</Trans>
                    </Item>
                    <Item disabled={busy} onSelect={() => onImportTemplate(true)}>
                      <Trans>Convert (delete original)</Trans>
                    </Item>
                  </Group>
                </SubContent>
              </Sub>
            ) : null}
            {onDuplicate ? (
              <Item disabled={busy} onSelect={onDuplicate}>
                <CopyPlus aria-hidden="true" />
                <Trans>Duplicate</Trans>
              </Item>
            ) : null}
            {onRename ? (
              <Item disabled={busy} onSelect={onRename}>
                <Pencil aria-hidden="true" />
                <Trans>Rename</Trans>
              </Item>
            ) : null}
            {hide ? (
              <Item
                data-testid="file-tree-menu-hide"
                disabled={hide.disabled}
                onSelect={hide.onSelect}
              >
                <EyeOff aria-hidden="true" />
                {hide.label}
              </Item>
            ) : null}
            {onDelete ? (
              <Item variant="destructive" disabled={busy} onSelect={onDelete}>
                <Trash2 aria-hidden="true" />
                {deleteLabel ?? <Trans>Delete</Trans>}
              </Item>
            ) : null}
          </Group>
        </>
      ) : null}
    </>
  );
}
