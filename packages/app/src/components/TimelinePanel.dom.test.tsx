/**
 * RTL mount test: the Timeline surfaces only actor/system commits.
 *
 * Pins two user-visible contracts from the "timeline shows only auto-commits"
 * change: (1) checkpoint rows are filtered out of the panel — they are
 * background-cleanup artifacts now, not user history; and (2) there is no
 * Save Version control in the panel header. The expand/diff/restore flow is
 * exercised by the Playwright suite (timeline-diff-sidepane.e2e.ts); this
 * mount test locks the filtering + header contract without a browser (and
 * without a shadow repo, which the e2e fixture requires).
 *
 * Invocation: `bun run test:dom` from `packages/app/`.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

mock.module('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

import type { TimelineEntry } from '@inkeep/open-knowledge-core';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TimelineContent } from './TimelinePanel';

function wipEntry(sha: string, author: string): TimelineEntry {
  return {
    sha,
    timestamp: '2026-04-17T00:00:00Z',
    author,
    authorEmail: `${author}@example.test`,
    type: 'wip',
    message: `wip: ${author} edit`,
    contributors: [{ id: author, name: author, docs: ['notes.md'] }],
    checkpoint: null,
  };
}

function checkpointEntry(sha: string): TimelineEntry {
  return {
    sha,
    timestamp: '2026-04-17T00:00:00Z',
    author: 'openknowledge-service',
    authorEmail: 'service@openknowledge.local',
    type: 'checkpoint',
    message: 'checkpoint: cleanup',
    contributors: [],
    checkpoint: null,
  };
}

function upstreamEntry(sha: string): TimelineEntry {
  return {
    sha,
    timestamp: '2026-04-17T00:00:00Z',
    author: 'git-upstream',
    authorEmail: 'upstream@openknowledge.local',
    type: 'upstream',
    message: 'import: upstream sync',
    contributors: [],
    checkpoint: null,
  };
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

function mockHistory(entries: TimelineEntry[]) {
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/history')) {
      return Promise.resolve(
        new Response(JSON.stringify({ entries }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  }) as never;
}

function renderTimeline() {
  return render(
    <TooltipProvider>
      <TimelineContent docName="notes" diffLayout="unified" onDiffLayoutChange={() => {}} />
    </TooltipProvider>,
  );
}

describe('TimelineContent — actor/system commits only', () => {
  test('filters out checkpoint rows; renders only WIP/system commits', async () => {
    mockHistory([
      wipEntry('a'.repeat(40), 'Alice'),
      checkpointEntry('c'.repeat(40)),
      wipEntry('b'.repeat(40), 'Bob'),
    ]);

    renderTimeline();

    // Two WIP rows render; the interleaved checkpoint row is dropped.
    await waitFor(() => {
      expect(screen.getAllByTestId('timeline-entry-expand')).toHaveLength(2);
    });
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('Bob')).toBeTruthy();
    // The checkpoint's commit message never reaches the DOM (row filtered out).
    expect(screen.queryByText('checkpoint: cleanup')).toBeNull();
  });

  test('keeps upstream-sync entries visible (exclude-by-type, not a wip allowlist)', async () => {
    // The filter is `type !== 'checkpoint'`, so non-wip system entries like
    // `upstream` pass through and render via their dedicated path
    // (displayAuthor → "Upstream sync"). Pins that the exclude-by-type choice
    // keeps a future/non-wip actor type visible rather than silently dropping it.
    mockHistory([wipEntry('a'.repeat(40), 'Alice'), upstreamEntry('u'.repeat(40))]);

    renderTimeline();

    await waitFor(() => {
      expect(screen.getAllByTestId('timeline-entry-expand')).toHaveLength(2);
    });
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('Upstream sync')).toBeTruthy();
  });

  test('a checkpoint-only history renders the empty state, never a checkpoint row', async () => {
    mockHistory([checkpointEntry('c'.repeat(40))]);

    renderTimeline();

    await waitFor(() => {
      expect(screen.getByText('No history yet')).toBeTruthy();
    });
    expect(screen.queryAllByTestId('timeline-entry-expand')).toHaveLength(0);
  });

  test('the panel header has no Save Version control', async () => {
    mockHistory([wipEntry('a'.repeat(40), 'Alice')]);

    renderTimeline();

    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeTruthy();
    });
    // Query by the user-facing affordance (role + accessible name), not the
    // deleted testid — this catches a re-introduced Save Version control even
    // under a different testid, where a tombstone testid query would stay green.
    expect(screen.queryByRole('button', { name: /save version/i })).toBeNull();
  });
});
