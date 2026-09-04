import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));
vi.mock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ activeProvider: null, activeDocName: 'notes' }),
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import {
  closeTimelineDiff,
  openTimelineDiff,
  type TimelineDiffView,
  useTimelineDiffView,
} from '@/lib/timeline-diff-store';

const { TimelineDiffPane } = await import('./TimelineDiffPane');

const VERSION_SHA = 'c'.repeat(40);
const PARENT_SHA = 'p'.repeat(40);
const PARENT_BODY = 'first line\nsecond line\n';
const VERSION_BODY = 'first line\nsecond line rewritten\n';

function viewFor(laterEdits: number): TimelineDiffView {
  return {
    docName: 'notes',
    sha: VERSION_SHA,
    parentSha: PARENT_SHA,
    laterEdits,
    authorName: 'Alice',
    relativeTime: '2 hours ago',
    absoluteTime: '2026-04-17 00:00',
  };
}

interface RollbackCall {
  body: unknown;
  signal: AbortSignal | null | undefined;
}

interface FetchHarness {
  rollbacks: RollbackCall[];
  release: () => void;
}

function mockDiffFetch({ holdRollback = false }: { holdRollback?: boolean } = {}): FetchHarness {
  const rollbacks: RollbackCall[] = [];
  let resolveHeld: ((res: Response) => void) | undefined;

  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes(`/api/history/${VERSION_SHA}`)) {
      return Promise.resolve(
        new Response(JSON.stringify({ content: VERSION_BODY }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    if (url.includes(`/api/history/${PARENT_SHA}`)) {
      return Promise.resolve(
        new Response(JSON.stringify({ content: PARENT_BODY }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    if (url.includes('/api/rollback')) {
      rollbacks.push({
        body: init?.body ? JSON.parse(init.body as string) : null,
        signal: init?.signal,
      });
      if (holdRollback) {
        return new Promise<Response>((resolve) => {
          resolveHeld = resolve;
        });
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  }) as never;

  return {
    rollbacks,
    release: () => resolveHeld?.(new Response(null, { status: 200 })),
  };
}

function DiffStoreProbe() {
  const view = useTimelineDiffView();
  return <span data-testid="diff-store-state">{view === null ? 'closed' : 'open'}</span>;
}

function renderPane(laterEdits: number) {
  const view = viewFor(laterEdits);
  openTimelineDiff(view);
  return render(
    <TooltipProvider>
      <DiffStoreProbe />
      <TimelineDiffPane view={view} isPanelCollapsed={false} onTogglePanel={() => {}} />
    </TooltipProvider>,
  );
}

async function waitForDiffBody() {
  await waitFor(() => expect(screen.queryByText('Loading diff')).toBeNull());
}

function restoreButton(): HTMLButtonElement {
  return screen.getByTestId('timeline-diff-restore') as HTMLButtonElement;
}

function storeState(): string {
  return screen.getByTestId('diff-store-state').textContent ?? '';
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  closeTimelineDiff();
  cleanup();
});

describe('TimelineDiffPane — its own Restore reaches the rollback', () => {
  test('confirming restores the VIEWED version, not its diff baseline', async () => {
    const { rollbacks } = mockDiffFetch();

    renderPane(2);
    await waitForDiffBody();

    fireEvent.click(restoreButton());

    const confirm = await screen.findByTestId('timeline-diff-restore-confirm');
    expect(rollbacks).toHaveLength(0);

    fireEvent.click(confirm);

    await waitFor(() => expect(rollbacks).toHaveLength(1));
    expect(rollbacks[0].body).toEqual({ docName: 'notes', commitSha: VERSION_SHA });
    await waitFor(() => expect(storeState()).toBe('closed'));
  });

  test('the newest version restores without a confirm; an older one always raises it', async () => {
    const zeroLater = mockDiffFetch({ holdRollback: true });
    renderPane(0);
    await waitForDiffBody();

    fireEvent.click(restoreButton());
    expect(zeroLater.rollbacks).toHaveLength(1);
    expect(zeroLater.rollbacks[0].body).toEqual({ docName: 'notes', commitSha: VERSION_SHA });
    expect(screen.queryByTestId('timeline-diff-restore-confirm')).toBeNull();

    zeroLater.release();
    await waitFor(() => expect(storeState()).toBe('closed'));
    cleanup();

    const withLater = mockDiffFetch({ holdRollback: true });
    renderPane(3);
    await waitForDiffBody();

    fireEvent.click(restoreButton());
    expect(await screen.findByTestId('timeline-diff-restore-confirm')).toBeTruthy();
    expect(withLater.rollbacks).toHaveLength(0);
  });
});

describe('TimelineDiffPane — dismissing its confirm leaves the document untouched', () => {
  test('Cancel closes the dialog, issues no rollback, and keeps the diff open', async () => {
    const { rollbacks } = mockDiffFetch();

    renderPane(2);
    await waitForDiffBody();
    fireEvent.click(restoreButton());
    await screen.findByTestId('timeline-diff-restore-confirm');

    fireEvent.click(screen.getByTestId('timeline-diff-restore-cancel'));

    await waitFor(() => expect(screen.queryByTestId('timeline-diff-restore-confirm')).toBeNull());
    expect(rollbacks).toHaveLength(0);
    expect(storeState()).toBe('open');
    expect(restoreButton().disabled).toBe(false);
  });

  test('Escape closes the dialog only — the pane keeps its place, and nothing rolls back', async () => {
    const { rollbacks } = mockDiffFetch();

    renderPane(2);
    await waitForDiffBody();
    fireEvent.click(restoreButton());
    await screen.findByTestId('timeline-diff-restore-confirm');

    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByTestId('timeline-diff-restore-confirm')).toBeNull());
    expect(rollbacks).toHaveLength(0);
    expect(storeState()).toBe('open');
    expect(screen.getByTestId('timeline-diff-pane')).toBeTruthy();
    expect(restoreButton().disabled).toBe(false);
  });
});

describe('TimelineDiffPane — an unresolved restore leaves no half-applied UI', () => {
  test('while the request hangs the pane stays whole, and no second rollback can be issued', async () => {
    const { rollbacks } = mockDiffFetch({ holdRollback: true });

    renderPane(2);
    await waitForDiffBody();
    fireEvent.click(restoreButton());
    const confirm = (await screen.findByTestId(
      'timeline-diff-restore-confirm',
    )) as HTMLButtonElement;

    fireEvent.click(confirm);
    await waitFor(() => expect(rollbacks).toHaveLength(1));

    expect(screen.getByTestId('timeline-diff-pane')).toBeTruthy();
    expect(screen.getByText('notes')).toBeTruthy();
    expect(storeState()).toBe('open');

    expect(confirm.disabled).toBe(true);
    expect(restoreButton().disabled).toBe(true);
    fireEvent.click(confirm);
    fireEvent.click(restoreButton());
    expect(rollbacks).toHaveLength(1);
  });

  test('closing the pane mid-flight abandons the wait without a second request', async () => {
    const { rollbacks, release } = mockDiffFetch({ holdRollback: true });

    const { unmount } = renderPane(2);
    await waitForDiffBody();
    fireEvent.click(restoreButton());
    fireEvent.click(await screen.findByTestId('timeline-diff-restore-confirm'));
    await waitFor(() => expect(rollbacks).toHaveLength(1));

    unmount();

    expect(rollbacks[0].signal?.aborted).toBe(true);
    release();
    await waitFor(() => expect(rollbacks).toHaveLength(1));
  });
});
