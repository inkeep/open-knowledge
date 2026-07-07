import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { subscribeToDocumentsChanged } from '@/lib/documents-events';

// Use a dummy ws URL: pool constructs but providers never reach the wire,
// matching `branch-invalidation.test.ts`'s established pattern.
mock.module('@/lib/use-collab-url', () => ({
  useCollabUrl: () => ({
    collabUrl: 'ws://localhost:1/collab',
    attempts: 0,
    terminal: false,
    lastError: null,
    retry: () => {},
  }),
}));

const { DocumentProvider, useDocumentContext } = await import('./DocumentContext');

function Harness() {
  const ctx = useDocumentContext();
  return (
    <button
      type="button"
      onClick={() => {
        void ctx.onBranchSwitched('feature');
      }}
    >
      Switch
    </button>
  );
}

function ProviderHarness({ children }: { children: ReactNode }) {
  return <DocumentProvider>{children}</DocumentProvider>;
}

describe('DocumentContext branch-switch derived-view fan-out', () => {
  afterEach(() => {
    cleanup();
  });

  test('onBranchSwitched fans out emitDocumentsChanged for files/backlinks/graph after handleBranchSwitched resolves', async () => {
    const received: string[][] = [];
    const unsubscribe = subscribeToDocumentsChanged((channels) => {
      received.push([...channels]);
    });

    try {
      render(<Harness />, { wrapper: ProviderHarness });
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Switch' }));

      // Allow handleBranchSwitched's awaited microtasks to flush.
      await new Promise((resolve) => setTimeout(resolve, 0));

      const branchFanout = received.find(
        (channels) =>
          channels.includes('files') &&
          channels.includes('backlinks') &&
          channels.includes('graph'),
      );
      expect(branchFanout).toBeDefined();
    } finally {
      unsubscribe();
    }
  });
});
