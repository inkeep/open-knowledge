import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { FileTargetMenuItems, type FileTargetMenuPrimitives } from './FileTargetMenuItems';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

function Container({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

function Item({
  children,
  disabled,
  onSelect,
  ...props
}: {
  children?: ReactNode;
  disabled?: boolean;
  onSelect?: () => void;
  [key: string]: unknown;
}) {
  return (
    <button type="button" role="menuitem" disabled={disabled} onClick={onSelect} {...props}>
      {children}
    </button>
  );
}

const primitives = {
  Group: Container,
  Item,
  Separator: () => <hr />,
  Sub: Container,
  SubContent: Container,
  SubTrigger: Item,
} satisfies FileTargetMenuPrimitives;

afterEach(cleanup);

describe('FileTargetMenuItems', () => {
  test('keeps the shared target action catalog and callbacks together', () => {
    const onDuplicate = vi.fn();
    const onRename = vi.fn();
    const onDelete = vi.fn();
    render(
      <div role="menu">
        <FileTargetMenuItems
          primitives={primitives}
          workspaceReady
          openWithAi={<Item>Open with AI</Item>}
          share={{ onSelect: () => {} }}
          onCopyFullPath={() => {}}
          onCopyRelativePath={() => {}}
          onImportTemplate={() => {}}
          onDuplicate={onDuplicate}
          onRename={onRename}
          hide={{ label: 'Hide this file', onSelect: () => {} }}
          onDelete={onDelete}
        />
      </div>,
    );

    for (const label of [
      'Open with AI',
      'Share',
      'Copy path',
      'Import as template',
      'Duplicate',
      'Rename',
      'Hide this file',
      'Delete',
    ]) {
      expect(screen.getByRole('menuitem', { name: label })).toBeTruthy();
    }

    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(onDuplicate).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  test('adds folder creation and tree actions without changing the target action component', () => {
    render(
      <div role="menu">
        <FileTargetMenuItems
          primitives={primitives}
          workspaceReady
          folderCreate={{
            onNewFile: () => {},
            onNewFolder: () => {},
            templateItems: <Item>Starter template</Item>,
          }}
          folderTree={{ onExpandAll: () => {}, onCollapseAll: () => {} }}
          onCopyFullPath={() => {}}
          onCopyRelativePath={() => {}}
        />
      </div>,
    );

    for (const label of [
      'New file',
      'New from template',
      'New folder',
      'Expand all',
      'Collapse all',
    ]) {
      expect(screen.getByRole('menuitem', { name: label })).toBeTruthy();
    }
  });
});
