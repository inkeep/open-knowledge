import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

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
vi.doMock('@/components/empty-state/CreateView', () => ({
  CreateView: () => <div data-testid="create-view" />,
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
vi.doMock('@/lib/documents-fetch', () => ({
  fetchDocumentListShared: async () => ({
    ok: true,
    body: { documents: [{ kind: 'document', docName: 'welcome' }] },
  }),
}));

afterEach(cleanup);

const { EmptyEditorState } = await import('./EmptyEditorState');

describe('EmptyEditorState session-panel-aware collapse', () => {
  test('neither panel open: renders the full view (composer surface present)', async () => {
    render(<EmptyEditorState />);
    await waitFor(() => expect(screen.getByTestId('create-view')).toBeTruthy());
    expect(screen.queryByTestId('empty-state-header')).toBeNull();
  });

  test('terminal open: header-only, bottom-anchored above the dock', async () => {
    render(<EmptyEditorState terminalOpen />);
    const header = await screen.findByTestId('empty-state-header');
    expect(screen.queryByTestId('create-view')).toBeNull();
    expect(header.closest('.justify-end')).not.toBeNull();
  });

  test('agents panel open: header-only too (the composer bubble must not compete), centered', async () => {
    render(<EmptyEditorState agentsOpen />);
    const header = await screen.findByTestId('empty-state-header');
    expect(screen.queryByTestId('create-view')).toBeNull();
    expect(header.closest('.justify-center')).not.toBeNull();
  });

  test('both panels open: the bottom dock wins the pose (it is what takes the space)', async () => {
    render(<EmptyEditorState terminalOpen agentsOpen />);
    const header = await screen.findByTestId('empty-state-header');
    expect(screen.queryByTestId('create-view')).toBeNull();
    expect(header.closest('.justify-end')).not.toBeNull();
  });
});
