import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));
vi.mock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ activeProvider: null, activeDocName: 'notes' }),
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import { openTimelineDiff, type TimelineDiffView } from '@/lib/timeline-diff-store';
import { pierreShadow } from '@/test-utils/pierre-shadow';

vi.doMock('@/components/ActivityPanelDiffView', async (importOriginal) => {
  const { ActivityPanelDiffView: Orig } =
    await importOriginal<typeof import('./ActivityPanelDiffView')>();
  function DelayedDiffView(props: Parameters<typeof Orig>[0]) {
    const [ready, setReady] = useState(false);
    useEffect(() => {
      const id = setTimeout(() => setReady(true), 300);
      return () => clearTimeout(id);
    }, []);
    return ready ? Orig(props) : null;
  }
  return { ActivityPanelDiffView: DelayedDiffView };
});

const { TimelineDiffPane } = await import('./TimelineDiffPane');
const { collectChangeAnchors, PROPERTY_CHANGE_ANCHOR_SELECTOR } = await import(
  '@/lib/diff-change-nav'
);

const VERSION_SHA = 'c'.repeat(40);
const PARENT_SHA = 'p'.repeat(40);

const BEFORE = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf'].join('\n');
const AFTER = ['alpha', 'BRAVO', 'charlie', 'delta', 'echo', 'FOXTROT', 'golf'].join('\n');
const EXPECTED_GROUPS = 2;

const BEFORE_WITH_FM = [
  '---',
  'title: First Draft',
  'date: 2024-01-01',
  '---',
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'foxtrot',
  'golf',
].join('\n');
const AFTER_WITH_FM = [
  '---',
  'title: Final Draft',
  'date: 2024-06-01',
  '---',
  'alpha',
  'BRAVO',
  'charlie',
  'delta',
  'echo',
  'FOXTROT',
  'golf',
].join('\n');

const view: TimelineDiffView = {
  docName: 'notes',
  sha: VERSION_SHA,
  parentSha: PARENT_SHA,
  laterEdits: 0,
  authorName: 'Alice',
  relativeTime: '2 hours ago',
  absoluteTime: '2026-04-17 00:00',
};

function mockVersions(parent: string, version: string): void {
  globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const content = url.includes(`/api/history/${PARENT_SHA}`)
      ? parent
      : url.includes(`/api/history/${VERSION_SHA}`)
        ? version
        : null;
    if (content === null) return Promise.resolve(new Response(null, { status: 404 }));
    return Promise.resolve(
      new Response(JSON.stringify({ content }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as never;
}

function renderPane() {
  openTimelineDiff(view);
  return render(
    <TooltipProvider>
      <TimelineDiffPane view={view} isPanelCollapsed={false} onTogglePanel={() => {}} />
    </TooltipProvider>,
  );
}

async function readDenominator(expected?: number): Promise<number> {
  await waitFor(() => expect(screen.queryByTestId('timeline-diff-next')).not.toBeNull(), {
    timeout: 5_000,
  });
  if (expected !== undefined) {
    await waitFor(
      () => {
        const readout = screen.queryByText(/\d+\s*\/\s*\d+/);
        const d = Number(readout?.textContent?.split('/')[1]?.trim());
        expect(d).toBe(expected);
      },
      { timeout: 6_000 },
    );
  }
  const readout = screen.getByText(/\d+\s*\/\s*\d+/);
  const denominator = readout.textContent?.split('/')[1]?.trim();
  expect(denominator).toBeTruthy();
  return Number(denominator);
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
  vi.restoreAllMocks();
});

describe('TimelineDiffPane — source-mode stepper', () => {
  test('the displayed denominator equals the anchors the stepper can reach', async () => {
    mockVersions(BEFORE, AFTER);
    const { container } = renderPane();
    await waitFor(() => expect(screen.queryByText('Loading diff')).toBeNull());
    await userEvent.click(screen.getByTestId('timeline-diff-render-source'));
    await pierreShadow(container as HTMLElement);

    const denominator = await readDenominator();
    const anchors = collectChangeAnchors(container as HTMLElement);
    expect(anchors).toHaveLength(EXPECTED_GROUPS);
    expect(denominator).toBe(anchors.length);
  });

  test('every step lands on a Pierre change row', async () => {
    mockVersions(BEFORE, AFTER);
    const { container } = renderPane();
    await waitFor(() => expect(screen.queryByText('Loading diff')).toBeNull());
    await userEvent.click(screen.getByTestId('timeline-diff-render-source'));
    await pierreShadow(container as HTMLElement);

    await waitFor(() => expect(screen.queryByTestId('timeline-diff-next')).not.toBeNull(), {
      timeout: 5_000,
    });

    const scrolled: Element[] = [];
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (
      this: HTMLElement,
    ) {
      scrolled.push(this);
    });

    const next = screen.getByTestId('timeline-diff-next');
    await userEvent.click(next);
    await userEvent.click(next);

    expect(scrolled.length).toBeGreaterThan(0);
    for (const el of scrolled) {
      expect(
        el.matches('[data-line-type="change-addition"], [data-line-type="change-deletion"]'),
      ).toBe(true);
    }
  });
});

describe('TimelineDiffPane — source-mode stepper with property changes', () => {
  test('denominator accounts for both property anchors and Pierre body change rows', async () => {
    mockVersions(BEFORE_WITH_FM, AFTER_WITH_FM);
    const { container } = renderPane();
    await waitFor(() => expect(screen.queryByText('Loading diff')).toBeNull());
    await userEvent.click(screen.getByTestId('timeline-diff-render-source'));
    await pierreShadow(container as HTMLElement);

    const EXPECTED_TOTAL = EXPECTED_GROUPS + 2;
    const denominator = await readDenominator(EXPECTED_TOTAL);
    const pierreAnchors = collectChangeAnchors(container as HTMLElement);
    const propertyRows = container.querySelectorAll(PROPERTY_CHANGE_ANCHOR_SELECTOR);
    expect(propertyRows).toHaveLength(2);
    expect(pierreAnchors).toHaveLength(EXPECTED_GROUPS);
    expect(denominator).toBe(EXPECTED_TOTAL);
  });
});
