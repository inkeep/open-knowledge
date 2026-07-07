/**
 * RTL behavior tests for EmptyEditorState's terminal-aware collapse.
 *
 * The empty state ("new tab" screen) must drop its composer bubble + starter
 * packs whenever a terminal is open — in EITHER dock position — because the
 * open terminal is its own AI entry point. Only the header pose differs:
 * bottom-anchored above a bottom dock, vertically centered beside a right
 * column. The full-view children (CreateView / OnboardingView subtrees) and
 * the document-list fetch are mocked at the module boundary so the assertions
 * pin exactly the branch this component owns.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

mock.module('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (input: TemplateStringsArray | string, ...values: unknown[]) =>
      typeof input === 'string'
        ? input
        : input.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

mock.module('@/components/empty-state/EmptyStateHeader', () => ({
  EmptyStateHeader: () => <div data-testid="empty-state-header" />,
}));
mock.module('@/components/empty-state/empty-state-copy', () => ({
  getEmptyStateCopy: () => ({ title: 'title', subtitle: 'subtitle' }),
}));
mock.module('@/components/empty-state/CreateView', () => ({
  CreateView: () => <div data-testid="create-view" />,
}));
mock.module('@/components/empty-state/CreatePromptComposer', () => ({
  CreatePromptComposer: () => <div data-testid="create-prompt-composer" />,
}));
mock.module('@/components/empty-state/CopyablePromptList', () => ({
  CopyablePromptList: () => <div data-testid="copyable-prompt-list" />,
}));
mock.module('@/components/PackCardGrid', () => ({
  PackCardGrid: () => <div data-testid="pack-card-grid" />,
}));
mock.module('@/components/SeedDialog', () => ({
  SeedDialog: () => null,
}));
mock.module('@/hooks/use-is-embedded', () => ({
  useIsEmbedded: () => false,
}));
mock.module('@/lib/documents-events', () => ({
  subscribeToDocumentsChanged: () => () => {},
}));
// One existing document → the non-onboarding (CreateView) branch of the full view.
mock.module('@/lib/documents-fetch', () => ({
  fetchDocumentListShared: async () => ({
    ok: true,
    body: { documents: [{ kind: 'document', docName: 'welcome' }] },
  }),
}));

import { EmptyEditorState } from './EmptyEditorState';

afterEach(cleanup);

describe('EmptyEditorState terminal-aware collapse', () => {
  test('no terminal: renders the full view (composer surface present)', async () => {
    render(<EmptyEditorState terminalDock={null} />);
    await waitFor(() => expect(screen.getByTestId('create-view')).toBeTruthy());
    expect(screen.queryByTestId('empty-state-header')).toBeNull();
  });

  test('bottom-docked terminal: header-only, bottom-anchored above the dock', async () => {
    render(<EmptyEditorState terminalDock="bottom" />);
    const header = await screen.findByTestId('empty-state-header');
    expect(screen.queryByTestId('create-view')).toBeNull();
    const pose = header.closest('.justify-end');
    expect(pose).not.toBeNull();
  });

  test('right-docked terminal: header-only too (the composer bubble must not compete), centered', async () => {
    render(<EmptyEditorState terminalDock="right" />);
    const header = await screen.findByTestId('empty-state-header');
    expect(screen.queryByTestId('create-view')).toBeNull();
    const pose = header.closest('.justify-center');
    expect(pose).not.toBeNull();
  });
});
