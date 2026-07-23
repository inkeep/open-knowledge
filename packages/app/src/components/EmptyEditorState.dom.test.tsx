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
// One existing document → the non-onboarding (CreateView) branch of the full view.
vi.doMock('@/lib/documents-fetch', () => ({
  fetchDocumentListShared: async () => ({
    ok: true,
    body: { documents: [{ kind: 'document', docName: 'welcome' }] },
  }),
}));

afterEach(cleanup);

// Import the component AFTER the mocks above register so its transitive
// dependencies bind to the stubs rather than the real modules.
const { EmptyEditorState } = await import('./EmptyEditorState');

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
