import type { TemplatesListEntry } from '@inkeep/open-knowledge-core';
import { DocumentListSuccessSchema } from '@inkeep/open-knowledge-core';
import * as actualLinguiMacro from '@lingui/react/macro';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { type ReactNode, useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AsyncState } from '@/hooks/use-folder-config';
import type { DocumentListFetchResult } from '@/lib/documents-fetch';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (input: TemplateStringsArray | string, ...values: unknown[]) =>
      typeof input === 'string'
        ? input
        : input.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

vi.doMock('@/components/empty-state/EmptyStateHeader', () => ({
  EmptyStateHeader: () => <div data-testid="empty-state-header" />,
}));
vi.doMock('@/components/empty-state/empty-state-copy', () => ({
  getEmptyStateCopy: () => ({ title: 'title', subtitle: 'subtitle' }),
}));
vi.doMock('@/components/empty-state/CreatePromptComposer', () => ({
  CreatePromptComposer: () => <div data-testid="create-prompt-composer" />,
}));
vi.doMock('@/components/empty-state/CopyablePromptList', () => ({
  CopyablePromptList: () => <div data-testid="copyable-prompt-list" />,
}));
vi.doMock('@/components/PackCardGrid', () => ({
  PackCardGrid: () => <div data-testid="pack-card-grid" />,
}));
vi.doMock('@/components/SeedDialog', () => ({
  SeedDialog: () => null,
}));
vi.doMock('@/hooks/use-is-embedded', () => ({
  useIsEmbedded: () => false,
}));
vi.doMock('@/lib/documents-events', () => ({
  subscribeToDocumentsChanged: () => () => {},
}));
const fetchDocumentListShared = vi.fn<() => Promise<DocumentListFetchResult>>();
vi.doMock('@/lib/documents-fetch', () => ({ fetchDocumentListShared }));
const useAllTemplates = vi.fn<() => AsyncState<readonly TemplatesListEntry[]>>();
vi.doMock('@/hooks/use-folder-config', () => ({ useAllTemplates }));

const templateFixture: TemplatesListEntry = {
  name: 'meeting-notes',
  title: 'Meeting Notes',
  path: 'meetings/meeting-notes.md',
  source_folder: 'meetings',
};

const templateRowName =
  'New file from template "Meeting Notes" (meeting-notes.md) in meetings/' as const;

function documentListBody(docNames: readonly string[]) {
  return {
    documents: docNames.map((docName) => ({
      kind: 'document' as const,
      docName,
      docExt: '.md',
      size: 12,
      modified: '2026-01-01T00:00:00.000Z',
    })),
  };
}

function documentListResult(docNames: readonly string[]): DocumentListFetchResult {
  return { ok: true, status: 200, body: documentListBody(docNames) };
}

beforeEach(() => {
  fetchDocumentListShared.mockResolvedValue(documentListResult(['welcome']));
  useAllTemplates.mockReset();
  useAllTemplates.mockReturnValue({ status: 'ready', data: [templateFixture] });
});

afterEach(cleanup);

const { EmptyEditorState } = await import('./EmptyEditorState');

const { subscribeToCreateTopLevelFile } = await import('@/lib/create-file-events');

const { TooltipProvider } = await import('@/components/ui/tooltip');

describe('EmptyEditorState file creation with session panels', () => {
  test.each([[[]], [['welcome']]])(
    'the document-list fixture satisfies the real success schema: %j',
    (docNames) => {
      expect(DocumentListSuccessSchema.safeParse(documentListBody(docNames)).success).toBe(true);
    },
  );

  test('closed panels show the composer, the starter-pack action and both create paths', async () => {
    const onCreate = vi.fn();
    const unsubscribe = subscribeToCreateTopLevelFile(onCreate);
    try {
      render(<EmptyEditorState />);
      await screen.findByRole('region', { name: 'From template' });
      expect(screen.getByTestId('create-prompt-composer')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Add a starter pack' })).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: templateRowName }));
      expect(onCreate).toHaveBeenLastCalledWith({
        template: { folder: 'meetings', name: 'meeting-notes' },
      });
      fireEvent.click(screen.getByRole('button', { name: /or create a new file/ }));
      expect(onCreate).toHaveBeenLastCalledWith({ initialDir: '' });
    } finally {
      unsubscribe();
    }
  });

  test('closed panels on an empty project show the onboarding starter packs', async () => {
    fetchDocumentListShared.mockResolvedValue(documentListResult([]));
    render(
      <TooltipProvider>
        <EmptyEditorState />
      </TooltipProvider>,
    );
    expect(await screen.findByTestId('pack-card-grid')).toBeTruthy();
  });

  describe.each([
    { name: 'agents', agentsOpen: true, terminalOpen: false },
    { name: 'terminal', agentsOpen: false, terminalOpen: true },
    { name: 'both panels', agentsOpen: true, terminalOpen: true },
  ])('$name open', ({ agentsOpen, terminalOpen }) => {
    test.each([false, true])('file actions work when project is empty: %s', async (empty) => {
      if (empty) fetchDocumentListShared.mockResolvedValue(documentListResult([]));
      const onCreate = vi.fn();
      const unsubscribe = subscribeToCreateTopLevelFile(onCreate);
      try {
        render(<EmptyEditorState agentsOpen={agentsOpen} terminalOpen={terminalOpen} />);
        const template = await screen.findByRole('button', { name: templateRowName });
        fireEvent.click(template);
        expect(onCreate).toHaveBeenLastCalledWith({
          template: { folder: 'meetings', name: 'meeting-notes' },
        });
        fireEvent.click(screen.getByRole('button', { name: /or create a new file/ }));
        expect(onCreate).toHaveBeenLastCalledWith({ initialDir: '' });
        expect(screen.queryByTestId('create-prompt-composer')).toBeNull();
        expect(screen.queryByTestId('pack-card-grid')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Add a starter pack' })).toBeNull();
      } finally {
        unsubscribe();
      }
    });
  });

  describe.each([
    {
      name: 'terminal docked bottom',
      props: { terminalOpen: true, bottomDockOpen: true },
      pose: 'mt-auto',
      notPose: 'my-auto',
    },
    {
      name: 'terminal docked right',
      props: { terminalOpen: true },
      pose: 'my-auto',
      notPose: 'mt-auto',
    },
    {
      name: 'agents only',
      props: { agentsOpen: true },
      pose: 'my-auto',
      notPose: 'mt-auto',
    },
    {
      name: 'agents plus terminal docked bottom',
      props: { agentsOpen: true, terminalOpen: true, bottomDockOpen: true },
      pose: 'mt-auto',
      notPose: 'my-auto',
    },
    {
      name: 'agents plus terminal docked right',
      props: { agentsOpen: true, terminalOpen: true },
      pose: 'my-auto',
      notPose: 'mt-auto',
    },
  ])('$name', ({ props, pose, notPose }) => {
    test(`anchors the panel content via .${pose}`, async () => {
      render(<EmptyEditorState {...props} />);
      const header = await screen.findByTestId('empty-state-header');
      expect(header.closest(`.${pose}`)).not.toBeNull();
      expect(header.closest(`.${notPose}`)).toBeNull();
    });
  });

  test('toggling the AI sidebar keeps file actions available and restores the composer', async () => {
    const { rerender } = render(<EmptyEditorState />);
    await screen.findByRole('region', { name: 'From template' });
    rerender(<EmptyEditorState agentsOpen />);
    expect(screen.getByRole('region', { name: 'From template' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /or create a new file/ })).toBeTruthy();
    expect(screen.queryByTestId('create-prompt-composer')).toBeNull();
    rerender(<EmptyEditorState />);
    expect(screen.getByTestId('create-prompt-composer')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'From template' })).toBeTruthy();
  });

  test.each([
    { agentsOpen: true },
    { terminalOpen: true },
    { agentsOpen: true, terminalOpen: true },
  ])('preserves loaded templates across panel toggles: %j', async (panelProps) => {
    fetchDocumentListShared.mockClear();
    const onMount = vi.fn();
    const onUnmount = vi.fn();
    let finishLoading: () => void = () => {};
    useAllTemplates.mockImplementation(function useTemplatesState() {
      const [state, setState] = useState<AsyncState<readonly TemplatesListEntry[]>>({
        status: 'loading',
      });
      useEffect(() => {
        onMount();
        finishLoading = () => setState({ status: 'ready', data: [templateFixture] });
        return onUnmount;
      }, []);
      return state;
    });

    const { rerender } = render(<EmptyEditorState />);
    await screen.findByText('Loading templates');
    act(() => finishLoading());
    expect(screen.getByRole('button', { name: templateRowName })).toBeTruthy();

    rerender(<EmptyEditorState {...panelProps} />);
    expect(screen.getByRole('button', { name: templateRowName })).toBeTruthy();
    expect(screen.queryByText('Loading templates')).toBeNull();

    rerender(<EmptyEditorState />);
    expect(screen.getByRole('button', { name: templateRowName })).toBeTruthy();
    expect(screen.queryByText('Loading templates')).toBeNull();
    expect(onMount).toHaveBeenCalledTimes(1);
    expect(onUnmount).not.toHaveBeenCalled();
    expect(fetchDocumentListShared).toHaveBeenCalledTimes(1);
  });

  test.each<AsyncState<readonly TemplatesListEntry[]>>([
    { status: 'idle' },
    { status: 'loading' },
    { status: 'error', message: 'boom' },
    { status: 'ready', data: [] },
  ])('blank-file action remains available with templates %j', async (templatesState) => {
    useAllTemplates.mockReturnValue(templatesState);
    render(<EmptyEditorState agentsOpen />);
    expect(await screen.findByRole('button', { name: /or create a new file/ })).toBeTruthy();
  });

  test('the action row drops its negative margin when no template section renders', async () => {
    useAllTemplates.mockReturnValue({ status: 'ready', data: [] });
    render(<EmptyEditorState agentsOpen />);
    const row = await screen.findByTestId('file-creation-action-row');
    expect(screen.queryByRole('region', { name: 'From template' })).toBeNull();
    expect(row.classList.contains('-mt-6')).toBe(false);
  });

  test('the action row keeps its negative margin beneath a rendered template section', async () => {
    render(<EmptyEditorState agentsOpen />);
    const row = await screen.findByTestId('file-creation-action-row');
    expect(screen.getByRole('region', { name: 'From template' })).toBeTruthy();
    expect(row.classList.contains('-mt-6')).toBe(true);
  });
});
