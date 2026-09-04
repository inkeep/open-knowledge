// @vitest-environment jsdom

import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';
import type { EditorTabFileTarget } from './EditorTabTargetMenuItems';

const scheduleClipboardWrite = vi.fn(() => Promise.resolve());

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

vi.doMock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.doMock('@/components/ui/context-menu', () => ({
  ContextMenuGroup: ({ children }: { children?: ReactNode }) => <>{children}</>,
  ContextMenuItem: ({
    children,
    disabled,
    onSelect,
    ...props
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onSelect?: () => void;
    [key: string]: unknown;
  }) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        if (!disabled) onSelect?.();
      }}
      {...props}
    >
      {children}
    </button>
  ),
  ContextMenuSeparator: () => <hr />,
  ContextMenuSub: ({ children }: { children?: ReactNode }) => <>{children}</>,
  ContextMenuSubContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  ContextMenuSubTrigger: ({
    children,
    disabled,
    ...props
  }: {
    children?: ReactNode;
    disabled?: boolean;
    [key: string]: unknown;
  }) => (
    <button type="button" role="menuitem" disabled={disabled} {...props}>
      {children}
    </button>
  ),
}));

vi.doMock('@/lib/use-workspace', () => ({
  useWorkspace: () => ({ contentDir: '/workspace', pathSeparator: '/' }),
}));

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({ okignoreBinding: { current: () => '', patch: vi.fn() } }),
}));

vi.doMock('@/hooks/use-git-sync-status', () => ({
  useGitSyncStatusDetailed: () => ({ status: { hasRemote: true } }),
}));

vi.doMock('@/components/handoff/useHandoffDispatch', () => ({
  useHandoffDispatch: () => ({ dispatch: vi.fn() }),
}));

vi.doMock('@/components/handoff/useInstalledAgents', () => ({
  useInstalledAgents: () => ({ states: {} }),
}));

vi.doMock('@/components/handoff/OpenInAgentEmptySpaceSubmenu', () => ({
  OpenInAgentEmptySpaceSubmenu: () => null,
}));

vi.doMock('@/components/template-menu-rows', () => ({
  TemplateMenuRows: () => null,
}));

vi.doMock('@/lib/share/clipboard-adapter', () => ({ scheduleClipboardWrite }));

vi.doMock('@/lib/file-menu-target-resolvers', () => ({
  buildSendToAiInputForActiveTarget: () => null,
  resolveActiveTargetRelativePath: (target: EditorTabFileTarget) =>
    target.kind === 'folder' ? target.folderPath : ((target as { docName?: string }).docName ?? ''),
}));

const { EditorTabTargetMenuItems } = await import('./EditorTabTargetMenuItems');

function renderMenu(target: EditorTabFileTarget) {
  return render(
    <div role="menu">
      <EditorTabTargetMenuItems target={target} onRename={() => {}} />
    </div>,
  );
}

function docTarget(docName: string): EditorTabFileTarget {
  return { kind: 'doc', target: docName, docName };
}

const OK_GATED_ACTIONS = ['Import as template', 'Duplicate', 'Rename', 'Hide this file', 'Delete'];

afterEach(() => {
  cleanup();
  scheduleClipboardWrite.mockClear();
});

describe('EditorTabTargetMenuItems — template doc tab', () => {
  test('the five .ok-gated mutation actions are withheld', () => {
    renderMenu(docTarget('docs/.ok/templates/note'));
    for (const label of OK_GATED_ACTIONS) {
      expect(screen.queryByRole('menuitem', { name: label })).toBeNull();
    }
  });

  test('Copy relative path stays enabled and copies the real on-disk path', () => {
    renderMenu(docTarget('docs/.ok/templates/note'));
    const relativePath = screen.getByRole('menuitem', { name: 'Relative path' });
    fireEvent.click(relativePath);
    expect(scheduleClipboardWrite).toHaveBeenCalledWith('docs/.ok/templates/note.md');
  });

  test('Share stays available (a template content doc has a real shareable path)', () => {
    renderMenu(docTarget('docs/.ok/templates/note'));
    expect(screen.getByRole('menuitem', { name: 'Share' })).toBeTruthy();
  });

  test('a project-root template tab is gated identically', () => {
    renderMenu(docTarget('.ok/templates/daily'));
    for (const label of OK_GATED_ACTIONS) {
      expect(screen.queryByRole('menuitem', { name: label })).toBeNull();
    }
    expect(screen.getByRole('menuitem', { name: 'Relative path' })).toBeTruthy();
  });
});

describe('EditorTabTargetMenuItems — ordinary doc control', () => {
  test('the same actions DO appear for a non-.ok doc, proving the gate is the .ok shape', () => {
    renderMenu(docTarget('docs/note'));
    for (const label of OK_GATED_ACTIONS) {
      expect(screen.getByRole('menuitem', { name: label })).toBeTruthy();
    }
  });

  test('Copy relative path on an ordinary doc copies its own on-disk path', () => {
    renderMenu(docTarget('docs/note'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Relative path' }));
    expect(scheduleClipboardWrite).toHaveBeenCalledWith('docs/note.md');
  });
});
