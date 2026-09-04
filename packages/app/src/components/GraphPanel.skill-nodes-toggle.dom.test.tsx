import * as actualLinguiMacro from '@lingui/react/macro';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

vi.doMock('@lingui/core/macro', () => ({
  ...actualLinguiMacro,
  t: renderLinguiTemplate,
  msg: renderLinguiTemplate,
}));

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Plural: ({ one }: { one: string }) => <>{one}</>,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

vi.doMock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

vi.doMock('@/components/PageListContext', () => ({
  usePageList: () => ({
    assetPaths: new Set<string>(),
    error: null,
    folderPaths: new Set<string>(),
    loading: false,
    pages: new Set<string>(['docs/Active']),
    pagesBySlug: new Map<string, string>(),
    pageMeta: new Map(),
    pageTitles: new Map([['docs/Active', 'Active']]),
    refetch: () => {},
    addPage: () => {},
  }),
}));

type DocSelection = {
  kind: 'doc';
  id: string;
  docName: string;
  label: string;
  anchor?: string;
};

const graphHarness: { select?: (selection: DocSelection) => void } = {};

vi.doMock('@/components/GraphView', () => ({
  GraphView: ({
    isExpanded,
    skillVisibility,
    onSelectNode,
  }: {
    isExpanded: boolean;
    skillVisibility: string;
    onSelectNode?: (selection: DocSelection) => void;
  }) => {
    graphHarness.select = onSelectNode;
    return (
      <div
        data-testid="graph-view"
        data-expanded={String(isExpanded)}
        data-skill-visibility={skillVisibility}
      />
    );
  },
}));

const PREF_KEY = 'ok-graph-fullscreen-skill-nodes-v1';

function installMemoryStorage(): Storage {
  const entries = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => void entries.delete(key),
    setItem: (key: string, value: string) => void entries.set(key, String(value)),
  };
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
    writable: true,
  });
  return storage;
}

async function renderPanel() {
  const { GraphPanel } = await import('./GraphPanel');
  render(
    <TooltipProvider>
      <GraphPanel activeDocName="docs/Active" />
    </TooltipProvider>,
  );
}

function graphView() {
  return screen.getByTestId('graph-view');
}

describe('GraphPanel skill-node visibility control', () => {
  beforeEach(() => {
    installMemoryStorage();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    graphHarness.select = undefined;
  });

  test('docked graph is unfiltered and offers no skill control', async () => {
    await renderPanel();

    expect(graphView().getAttribute('data-skill-visibility')).toBe('all');
    expect(screen.queryByRole('button', { name: 'Hide skill nodes' })).toBeNull();
  });

  test('fullscreen hides built-ins by default while still showing user skills', async () => {
    await renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Expand graph' }));

    expect(graphView().getAttribute('data-skill-visibility')).toBe('hide-builtins');
    expect(window.localStorage.getItem(PREF_KEY)).toBeNull();
  });

  test('toggling off hides every skill node and persists the deviation', async () => {
    await renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Expand graph' }));
    await userEvent.click(screen.getByRole('button', { name: 'Hide skill nodes' }));

    expect(graphView().getAttribute('data-skill-visibility')).toBe('none');
    expect(window.localStorage.getItem(PREF_KEY)).toBe('false');

    await userEvent.click(screen.getByRole('button', { name: 'Show skill nodes' }));
    expect(graphView().getAttribute('data-skill-visibility')).toBe('hide-builtins');
    expect(window.localStorage.getItem(PREF_KEY)).toBeNull();
  });

  test('hiding skills dismisses a selected skill that is no longer drawn', async () => {
    await renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Expand graph' }));
    act(() => {
      graphHarness.select?.({
        kind: 'doc',
        id: 'skill-1',
        docName: '.claude/skills/team-conventions/SKILL',
        label: 'Team conventions',
      });
    });
    expect(screen.getByRole('status', { name: 'Selected graph item' })).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Hide skill nodes' }));

    expect(screen.queryByRole('status', { name: 'Selected graph item' })).toBeNull();
  });

  test('hiding skills keeps a selected content document', async () => {
    await renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Expand graph' }));
    act(() => {
      graphHarness.select?.({
        kind: 'doc',
        id: 'doc-1',
        docName: 'docs/Notes',
        label: 'Notes',
      });
    });

    await userEvent.click(screen.getByRole('button', { name: 'Hide skill nodes' }));

    expect(screen.getByRole('status', { name: 'Selected graph item' })).toBeTruthy();
  });

  test('a stored off preference is restored on mount', async () => {
    window.localStorage.setItem(PREF_KEY, 'false');
    await renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Expand graph' }));

    expect(graphView().getAttribute('data-skill-visibility')).toBe('none');
  });
});
