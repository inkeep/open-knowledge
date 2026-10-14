import type { WorktreeSelectorModel } from '@inkeep/open-knowledge-core';
import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { DocumentStats } from '@/lib/document-stats';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) => (
    <>{value === 1 ? one : other}</>
  ),
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

let branch: string | null = null;
let worktreeModel: WorktreeSelectorModel | null = null;

vi.doMock('@/hooks/use-current-branch', () => ({ useCurrentBranch: () => branch }));
vi.doMock('@/hooks/use-worktrees', () => ({ useWorktrees: () => worktreeModel }));

const STATS: DocumentStats = { words: 10, chars: 50, tokens: 12 };

function model(currentWorktreePath: string): WorktreeSelectorModel {
  return {
    mainRoot: '/work/acme-notes',
    currentBranch: null,
    remoteBranches: [],
    entries: [
      {
        branch: 'main',
        worktreePath: '/work/acme-notes',
        isCurrent: currentWorktreePath === '/work/acme-notes',
        isMain: true,
        locked: false,
      },
      {
        branch: 'feat/new-layout',
        worktreePath: '/work/acme-notes-feature',
        isCurrent: currentWorktreePath === '/work/acme-notes-feature',
        isMain: false,
        locked: false,
      },
      {
        branch: null,
        worktreePath: '/work/acme-notes-review',
        isCurrent: currentWorktreePath === '/work/acme-notes-review',
        isMain: false,
        locked: false,
      },
    ],
  };
}

function installDesktopProject(projectName: string, projectPath: string) {
  Object.defineProperty(window, 'okDesktop', {
    configurable: true,
    value: { config: { projectName, projectPath } },
  });
}

async function renderFooter() {
  const { EditorFooter } = await import('./EditorFooter');
  return render(
    <TooltipProvider delayDuration={0}>
      <EditorFooter stats={STATS} />
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  branch = null;
  worktreeModel = null;
  Object.defineProperty(window, 'okDesktop', { configurable: true, value: undefined });
});

describe('EditorFooter checkout detail', () => {
  test.each([
    {
      name: 'a nested project in a worktree on a branch',
      projectName: 'docs',
      projectPath: '/work/acme-notes-feature/docs',
      checkout: '/work/acme-notes-feature',
      currentBranch: 'feat/new-layout',
      expected: 'docs · feat/new-layout',
    },
    {
      name: 'a nested project in a worktree with no branch',
      projectName: 'docs',
      projectPath: '/work/acme-notes-review/docs',
      checkout: '/work/acme-notes-review',
      currentBranch: null,
      expected: 'docs · acme-notes-review',
    },
    {
      name: 'a project at the root of the original clone',
      projectName: 'acme-notes',
      projectPath: '/work/acme-notes',
      checkout: '/work/acme-notes',
      currentBranch: 'main',
      expected: 'main',
    },
    {
      name: 'a project at the root of a worktree',
      projectName: 'acme-notes-feature',
      projectPath: '/work/acme-notes-feature',
      checkout: '/work/acme-notes-feature',
      currentBranch: 'feat/new-layout',
      expected: 'acme-notes-feature · feat/new-layout',
    },
  ])('shows what the project switcher used to show on its second line for $name', async (row) => {
    installDesktopProject(row.projectName, row.projectPath);
    branch = row.currentBranch;
    worktreeModel = model(row.checkout);
    await renderFooter();

    expect(screen.getByTestId('editor-footer-branch').textContent).toBe(row.expected);
    expect(screen.queryByText('acme-notes', { exact: true })).toBeNull();
  });

  test('keyboard focus on the checkout detail reveals the full project path', async () => {
    installDesktopProject('docs', '/work/acme-notes-feature/docs');
    branch = 'feat/new-layout';
    worktreeModel = model('/work/acme-notes-feature');
    await renderFooter();

    const trigger = screen.getByTestId('editor-footer-checkout');
    expect(trigger.tabIndex).toBe(0);
    fireEvent.focus(trigger);
    expect((await screen.findByRole('tooltip')).textContent).toContain(
      '/work/acme-notes-feature/docs',
    );
  });

  test('on the web, with no desktop project, the footer shows the branch alone and no path target', async () => {
    branch = 'main';
    await renderFooter();

    expect(screen.getByTestId('editor-footer-branch').textContent).toBe('main');
    expect(screen.queryByTestId('editor-footer-checkout')).toBeNull();
  });
});
