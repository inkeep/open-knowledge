import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));
vi.mock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ activeProvider: null, activeDocName: 'notes' }),
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import type { TimelineDiffView } from '@/lib/timeline-diff-store';

const { TimelineDiffPane } = await import('./TimelineDiffPane');

const MISSING_SHA = 'a'.repeat(40);
const PRESENT_SHA = 'b'.repeat(40);

function viewFor(sha: string): TimelineDiffView {
  return {
    docName: 'notes',
    sha,
    parentSha: null,
    laterEdits: 0,
    authorName: 'Alice',
    relativeTime: '2 hours ago',
    absoluteTime: '2026-04-17 00:00',
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('TimelineDiffPane destination settlement', () => {
  test('a failed selection does not settle the next selection as failed', async () => {
    let releasePresent: (() => void) | undefined;
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes(`/api/history/${PRESENT_SHA}`)) {
        return new Promise<Response>((resolve) => {
          releasePresent = () =>
            resolve(
              new Response(JSON.stringify({ content: 'present\n' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            );
        });
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as never;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onDestinationComplete = vi.fn();
    const onDestinationFailed = vi.fn();
    const pane = (sha: string) => (
      <TooltipProvider>
        <TimelineDiffPane
          view={viewFor(sha)}
          isPanelCollapsed={false}
          onTogglePanel={() => {}}
          onDestinationComplete={onDestinationComplete}
          onDestinationFailed={onDestinationFailed}
        />
      </TooltipProvider>
    );

    const { rerender } = render(pane(MISSING_SHA));
    await waitFor(() => expect(onDestinationFailed).toHaveBeenCalledTimes(1));

    rerender(pane(PRESENT_SHA));
    await waitFor(() => expect(releasePresent).toBeDefined());
    expect(onDestinationFailed).toHaveBeenCalledTimes(1);
    releasePresent?.();

    await waitFor(() => expect(onDestinationComplete).toHaveBeenCalledTimes(1));
    expect(onDestinationFailed).toHaveBeenCalledTimes(1);
  });
});
