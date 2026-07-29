/**
 * RTL mount test: the Timeline surfaces actor/system commits plus surfaced
 * rescue checkpoints.
 *
 * Pins the user-visible contracts: (1) actor/system rows render; (2) a
 * recovered-content rescue checkpoint (a registry-`surfaced` kind) renders as
 * an ordinary "Recovered content" version with a restore control; (3) routine
 * checkpoints stay out — registry-`hidden` kinds (auto-consolidation) and
 * null-kind Save-Version / cleanup rows; and (4) there is no Save Version
 * control in the panel header. This mount test locks the registry-driven
 * filtering + header contract without a browser (and without a shadow repo).
 * The click-restore journey has browser-tier coverage in
 * `tests/stress/timeline-recovered-restore.e2e.ts`.
 *
 * Invocation: `pnpm run test:dom` from `packages/app/`.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// `vi.mock` is hoisted above every import, so `next-themes` resolves to this
// stub before the SUT (imported dynamically below) pulls in its transitive
// `useTheme`.
vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

import {
  CHECKPOINT_KINDS,
  isSurfacedCheckpointKind,
  type ParsedCheckpoint,
  type TimelineEntry,
} from '@inkeep/open-knowledge-core';
import { TooltipProvider } from '@/components/ui/tooltip';

// Import the component AFTER the next-themes mock registers so its transitive
// `useTheme` import binds to the stub rather than the real provider.
const { TimelineContent } = await import('./TimelinePanel');

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

/** A silent rescue checkpoint the shared kind registry marks `surfaced`. */
function recoveredCheckpointEntry(sha: string, checkpoint: ParsedCheckpoint): TimelineEntry {
  return {
    sha,
    timestamp: '2026-04-17T00:00:00Z',
    author: 'openknowledge',
    authorEmail: 'noreply@openknowledge.local',
    type: 'checkpoint',
    // The raw checkpoint subject carries an internal, timestamped label; the UI
    // must never render it — it shows the "Recovered content" framing instead.
    message: 'checkpoint: Before concurrent merge @ 2026-05-05T12:00:00Z',
    contributors: [],
    checkpoint,
  };
}

const BRIDGE_MERGE_LOSS: ParsedCheckpoint = {
  kind: 'bridge-merge-loss',
  docName: 'notes',
  size: 12,
  metadata: { lostSubstrings: ['the keystroke'] },
};
const SURFACED_KINDS: ParsedCheckpoint[] = [
  BRIDGE_MERGE_LOSS,
  { kind: 'producer-guard-loss', docName: 'notes', size: 12, metadata: { construct: 'paragraph' } },
  {
    kind: 'observer-a-duplication',
    docName: 'notes',
    size: 12,
    metadata: { duplicatedLineCount: 1 },
  },
  {
    kind: 'external-change-rescue',
    docName: 'notes',
    size: 12,
    metadata: { incomingDiskSha: 'abc123' },
  },
  { kind: 'defer-exhaustion-loss', docName: 'notes', size: 12, metadata: { deferCount: 9 } },
  {
    kind: 'bridge-derive-loss',
    docName: 'notes',
    size: 12,
    metadata: { lostSubstrings: ['the keystroke'] },
  },
  {
    kind: 'observer-a-apply-loss',
    docName: 'notes',
    size: 12,
    metadata: { lostSubstrings: ['the keystroke'] },
  },
  { kind: 'bridge-backstop-trip', docName: 'notes', size: 12, metadata: { rounds: 8 } },
  {
    kind: 'persistence-reconcile-loss',
    docName: 'notes',
    size: 12,
    metadata: { atRiskLines: 1, witnessAvailable: true },
  },
  {
    kind: 'persistence-duplication-reset',
    docName: 'notes',
    size: 12,
    metadata: { copies: 2, fragmentChildren: 18 },
  },
  {
    kind: 'persistence-divergence-realign',
    docName: 'notes',
    size: 12,
    metadata: { diskBytes: 37, discardedBytes: 79 },
  },
  {
    kind: 'managed-artifact-reconcile',
    docName: '.ok/templates/daily',
    size: 12,
    metadata: { diskBytes: 41, discardedBytes: 66 },
  },
];
const AUTO_CONSOLIDATION: ParsedCheckpoint = {
  kind: 'auto-consolidation',
  docName: 'notes',
  size: 12,
  metadata: { foldedRefs: 3, trigger: 'ttl' },
};

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

function mockHistory(entries: TimelineEntry[]) {
  globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
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
      <TimelineContent docName="notes" />
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
      expect(screen.getAllByTestId('timeline-entry-open')).toHaveLength(2);
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
      expect(screen.getAllByTestId('timeline-entry-open')).toHaveLength(2);
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
    expect(screen.queryAllByTestId('timeline-entry-open')).toHaveLength(0);
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

describe('TimelineContent — recovered-content checkpoints', () => {
  test('a surfaced rescue checkpoint renders as a Recovered content version with a restore control', async () => {
    mockHistory([
      wipEntry('a'.repeat(40), 'Alice'),
      recoveredCheckpointEntry('c'.repeat(40), BRIDGE_MERGE_LOSS),
    ]);

    renderTimeline();

    // Both the WIP row and the recovered checkpoint render.
    await waitFor(() => {
      expect(screen.getAllByTestId('timeline-entry-open')).toHaveLength(2);
    });
    // The recovered row shows the registry-driven framing, never the raw
    // service author or the internal, timestamped checkpoint subject.
    expect(screen.getByText('Recovered content')).toBeTruthy();
    expect(screen.queryByText(/Before concurrent merge/)).toBeNull();
    expect(screen.queryByText('openknowledge')).toBeNull();
    // Every row — the recovered one included — carries a restore affordance.
    expect(screen.getAllByTestId('timeline-entry-restore')).toHaveLength(2);
  });

  test('the surfaced-kind fixture covers every kind the registry surfaces (fail-closed)', () => {
    const registrySurfaced = CHECKPOINT_KINDS.filter((k) => isSurfacedCheckpointKind(k)).sort();
    const covered = [...new Set(SURFACED_KINDS.map((c) => c.kind))].sort();
    expect(covered).toEqual(registrySurfaced);
  });

  test('every surfaced rescue kind renders under the same Recovered content label', async () => {
    for (const checkpoint of SURFACED_KINDS) {
      mockHistory([recoveredCheckpointEntry('c'.repeat(40), checkpoint)]);
      renderTimeline();
      await waitFor(() => {
        expect(screen.getByText('Recovered content')).toBeTruthy();
      });
      // No internal kind name (e.g. "producer-guard-loss") leaks into the UI.
      expect(screen.queryByText(new RegExp(checkpoint.kind))).toBeNull();
      cleanup();
    }
  });

  test('a registry-hidden kind (auto-consolidation) never renders', async () => {
    mockHistory([
      wipEntry('a'.repeat(40), 'Alice'),
      recoveredCheckpointEntry('c'.repeat(40), AUTO_CONSOLIDATION),
    ]);

    renderTimeline();

    await waitFor(() => {
      expect(screen.getAllByTestId('timeline-entry-open')).toHaveLength(1);
    });
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.queryByText('Recovered content')).toBeNull();
  });

  test('restoring a recovered row (with later edits) confirms, then POSTs /api/rollback for its sha', async () => {
    const recoveredSha = 'c'.repeat(40);
    const rollbackBodies: unknown[] = [];
    // A newer WIP row above the recovered checkpoint gives it laterEdits > 0, so
    // restore is destructive and must route through the confirm dialog rather
    // than firing instantly.
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/history')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              entries: [
                wipEntry('a'.repeat(40), 'Alice'),
                recoveredCheckpointEntry(recoveredSha, BRIDGE_MERGE_LOSS),
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url.includes('/api/rollback')) {
        rollbackBodies.push(init?.body ? JSON.parse(init.body as string) : null);
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as never;

    renderTimeline();
    await waitFor(() => expect(screen.getByText('Recovered content')).toBeTruthy());

    // The recovered row is second (Alice is newer) → laterEdits > 0.
    fireEvent.click(screen.getAllByTestId('timeline-entry-restore')[1]);

    // The confirm dialog gates the restore — nothing has been rolled back yet.
    const confirm = await screen.findByTestId('timeline-entry-restore-confirm');
    expect(rollbackBodies).toHaveLength(0);

    fireEvent.click(confirm);

    // Confirming issues exactly one rollback for the recovered checkpoint's sha.
    await waitFor(() => expect(rollbackBodies).toHaveLength(1));
    expect(rollbackBodies[0]).toEqual({ docName: 'notes', commitSha: recoveredSha });
  });
});
