// @vitest-environment jsdom

import * as actualLinguiMacro from '@lingui/react/macro';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { pierreShadow } from '@/test-utils/pierre-shadow';

vi.mock('@/components/RenderedDiffView', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/components/RenderedDiffView')>();
  return {
    ...mod,
    computeRenderedDiff: () => ({ ok: false as const }),
    RenderedDiffView: () => null,
  };
});

vi.mock('@/lib/use-activity-panel', () => ({
  fetchAgentBurstDiff: () =>
    Promise.resolve({
      diff: '--- a\n+++ b\n@@ -1,3 +1,3 @@\n line one\n-original line\n+changed line\n line three\n',
      before: 'line one\noriginal line\nline three\n',
      after: 'line one\nchanged line\nline three\n',
      properties: { changes: [], unparseable: null },
    }),
}));

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (s: string) => s }),
}));

const { collectChangeAnchors, watchPierreShadowRoots } = await import('./diff-change-nav');
const { ActivityPanelDiffView } = await import('@/components/ActivityPanelDiffView');
const { AgentDiffPane } = await import('@/components/AgentDiffPane');
const { TooltipProvider } = await import('@/components/ui/tooltip');

const SIMPLE_BEFORE = 'line one\nline two\noriginal line\nline four\nline five\n';
const SIMPLE_AFTER = 'line one\nline two\nchanged line\nline four\nline five\n';

const TWO_GROUP_BEFORE = 'line 1\noriginal A\nline 3\nline 4\noriginal B\nline 6\n';
const TWO_GROUP_AFTER = 'line 1\nchanged A\nline 3\nline 4\nchanged B\nline 6\n';

const ADJACENT_BEFORE = 'line 1\noriginal A\noriginal B\nline 4\n';
const ADJACENT_AFTER = 'line 1\nchanged A\nchanged B\nline 4\n';

async function settle(n = 2) {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('watchPierreShadowRoots — mutations Pierre makes inside the shadow root', () => {
  test('fires for a shadow-root mutation that a light-DOM observer cannot see', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const host = document.createElement('diffs-container');
    container.appendChild(host);
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });

    let lightHits = 0;
    const lightObserver = new MutationObserver(() => {
      lightHits += 1;
    });
    lightObserver.observe(container, { childList: true, subtree: true });

    let watcherHits = 0;
    const watcher = watchPierreShadowRoots(container, () => {
      watcherHits += 1;
    });
    watcher.sync();

    shadow.appendChild(document.createElement('span'));
    await waitFor(() => expect(watcherHits).toBeGreaterThan(0));
    expect(lightHits).toBe(0);

    watcher.disconnect();
    const hitsAtDisconnect = watcherHits;
    shadow.appendChild(document.createElement('span'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(watcherHits).toBe(hitsAtDisconnect);

    lightObserver.disconnect();
    container.remove();
  });

  test('sync is idempotent — a second call does not double-observe a shadow root', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const host = document.createElement('diffs-container');
    container.appendChild(host);
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });

    let hits = 0;
    const watcher = watchPierreShadowRoots(container, () => {
      hits += 1;
    });
    watcher.sync();
    watcher.sync();

    shadow.appendChild(document.createElement('span'));
    await waitFor(() => expect(hits).toBe(1));

    watcher.disconnect();
    container.remove();
  });
});

describe('collectChangeAnchors — shadow root piercing', () => {
  test('returns empty for unchanged before/after (no Pierre rows)', async () => {
    const { container } = render(
      <ActivityPanelDiffView before="same\n" after="same\n" cacheKey="doc@v1" />,
    );
    await settle();
    expect(collectChangeAnchors(container)).toHaveLength(0);
  });

  test('finds change rows inside the Pierre shadow root for a changed diff', async () => {
    const { container } = render(
      <ActivityPanelDiffView before={SIMPLE_BEFORE} after={SIMPLE_AFTER} cacheKey="doc@v1" />,
    );
    await pierreShadow(container);
    const anchors = collectChangeAnchors(container);
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) {
      expect(anchor.getRootNode()).toBeInstanceOf(ShadowRoot);
    }
  });

  test('each anchor is the first row of a consecutive changed-row run', async () => {
    const { container } = render(
      <ActivityPanelDiffView before={TWO_GROUP_BEFORE} after={TWO_GROUP_AFTER} cacheKey="doc@v1" />,
    );
    await pierreShadow(container);
    const anchors = collectChangeAnchors(container);
    expect(anchors.length).toBeGreaterThanOrEqual(2);
  });

  test('adjacent changed rows are grouped into a single anchor', async () => {
    const { container } = render(
      <ActivityPanelDiffView before={ADJACENT_BEFORE} after={ADJACENT_AFTER} cacheKey="doc@v1" />,
    );
    await pierreShadow(container);
    const anchors = collectChangeAnchors(container);
    expect(anchors).toHaveLength(1);
  });
});

describe('child combinator selector — 2× vs N rows', () => {
  test('naive [data-line-type] selector returns 2× what the scoped selector returns', async () => {
    const { container } = render(
      <ActivityPanelDiffView before={SIMPLE_BEFORE} after={SIMPLE_AFTER} cacheKey="doc@v1" />,
    );
    const root = await pierreShadow(container);

    const naiveAdditions = root.querySelectorAll('[data-line-type="change-addition"]').length;
    const scopedAdditions = root.querySelectorAll(
      '[data-content] > [data-line-type="change-addition"]',
    ).length;

    expect(naiveAdditions).toBeGreaterThan(0);
    expect(scopedAdditions).toBeGreaterThan(0);
    expect(naiveAdditions).toBe(scopedAdditions * 2);

    expect(collectChangeAnchors(container)).toHaveLength(scopedAdditions);
  });
});

describe('data-line-type canary', () => {
  test('a known fixture yields at least one change-addition and change-deletion in the shadow root', async () => {
    const { container } = render(
      <ActivityPanelDiffView before={SIMPLE_BEFORE} after={SIMPLE_AFTER} cacheKey="doc@v1" />,
    );
    const root = await pierreShadow(container);
    expect(
      root.querySelector('[data-content] > [data-line-type="change-addition"]'),
    ).not.toBeNull();
    expect(
      root.querySelector('[data-content] > [data-line-type="change-deletion"]'),
    ).not.toBeNull();
  });
});

describe('AgentDiffPane scroll-to-first-change via Pierre', () => {
  const view = {
    agentId: 'agent-1',
    agentName: 'Agent',
    agentColor: '#888888',
    docName: 'notes',
    keptCount: 1,
    maxVersions: 3,
  };

  test('scrollIntoView is called on a Pierre change row after the settle sequence', async () => {
    const scrolled: HTMLElement[] = [];
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (
      this: HTMLElement,
    ) {
      scrolled.push(this);
    });

    render(
      <TooltipProvider>
        <AgentDiffPane view={view} isPanelCollapsed={false} onTogglePanel={() => {}} />
      </TooltipProvider>,
    );

    await waitFor(
      () => {
        const pierreRow = scrolled.find((el) =>
          el.matches('[data-line-type="change-addition"], [data-line-type="change-deletion"]'),
        );
        expect(pierreRow).toBeDefined();
      },
      { timeout: 5000 },
    );
  });
});
