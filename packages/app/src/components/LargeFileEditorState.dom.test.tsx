import { DOCUMENT_OPEN_BYTE_LIMIT } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { LargeFileEditorState } from './LargeFileEditorState';

describe('LargeFileEditorState', () => {
  afterEach(() => cleanup());

  test('renders the blocked-open copy with formatted sizes', () => {
    const oversizedBytes = 768 * 1024;

    render(
      <LargeFileEditorState
        docName="big-note"
        size={oversizedBytes}
        limit={DOCUMENT_OPEN_BYTE_LIMIT}
      />,
    );

    expect(screen.getByRole('status').getAttribute('data-slot')).toBe('large-file-editor-state');
    expect(screen.getByRole('heading', { name: /file too large to open/i })).toBeTruthy();
    expect(screen.getByText(/big-note/).textContent).toContain('768 KiB');
    expect(screen.getByText(/big-note/).textContent).toContain('512 KiB');
    expect(screen.queryByRole('button', { name: /go back/i })).toBeNull();
  });

  test('two panes showing a large file each label their own heading', () => {
    const { container } = render(
      <>
        <LargeFileEditorState docName="one" size={768 * 1024} limit={DOCUMENT_OPEN_BYTE_LIMIT} />
        <LargeFileEditorState docName="two" size={768 * 1024} limit={DOCUMENT_OPEN_BYTE_LIMIT} />
      </>,
    );

    const labelledBy = [...container.querySelectorAll('[role="status"]')].map((node) =>
      node.getAttribute('aria-labelledby'),
    );
    expect(labelledBy.filter(Boolean).length).toBe(2);
    expect(new Set(labelledBy).size).toBe(2);

    const ids = [...container.querySelectorAll('[id]')].map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of labelledBy) {
      expect(ids.filter((candidate) => candidate === id)).toHaveLength(1);
    }
  });

  // The heading's ref now travels through EmptyTitle's Slot before it reaches
  // the h2, so mount-time focus depends on Slot forwarding the child's own ref
  // when the wrapper supplies none. Nothing else pins that, and a radix bump or
  // a shadcn re-sync could silently take it away.
  test('heading takes focus on mount when there is no back button', () => {
    render(
      <LargeFileEditorState
        docName="big-note"
        size={768 * 1024}
        limit={DOCUMENT_OPEN_BYTE_LIMIT}
      />,
    );

    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: /file too large to open/i }),
    );
  });

  test('back button takes focus on mount when it is present', () => {
    render(
      <LargeFileEditorState
        docName="big-note"
        size={768 * 1024}
        limit={DOCUMENT_OPEN_BYTE_LIMIT}
        backNav={{ previousDocName: 'small-note', onNavigateBack: vi.fn() }}
      />,
    );

    expect(document.activeElement).toBe(screen.getByRole('button', { name: /go back/i }));
  });

  test('go back action routes to the previous document', async () => {
    const onNavigateBack = vi.fn(() => {});
    render(
      <LargeFileEditorState
        docName="big-note"
        size={768 * 1024}
        limit={DOCUMENT_OPEN_BYTE_LIMIT}
        backNav={{ previousDocName: 'small-note', onNavigateBack }}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /go back/i }));

    expect(onNavigateBack).toHaveBeenCalledWith('small-note');
  });
});
