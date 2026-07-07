/**
 * Behavioral tests for DocPanel's single-file tab gating.
 *
 * Single-file `ok <file>` keeps only the Outline tab — Links/Graph need a
 * multi-doc knowledge base and Timeline is git history, all empty/inert for a
 * lone git-off file. Asserts the rendered tab set (by `role="tab"` count, so the
 * test doesn't depend on localized label text) and that a persisted
 * links/graph/timeline selection coerces back to Outline.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

// Radix ToggleGroup/Tooltip reach for ResizeObserver/NodeFilter in jsdom.
type WindowGlobals = { NodeFilter?: typeof NodeFilter };
type GlobalWithDomShims = typeof globalThis &
  WindowGlobals & { window?: WindowGlobals; ResizeObserver?: unknown };
const g = globalThis as GlobalWithDomShims;
if (g.NodeFilter === undefined && g.window?.NodeFilter !== undefined) {
  g.NodeFilter = g.window.NodeFilter;
}
if (g.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  g.ResizeObserver = NoopResizeObserver;
}

mock.module('@lingui/core/macro', () => ({ t: renderLinguiTemplate }));
mock.module('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

// Single-file signal — flipped per test.
let singleFileValue = false;
mock.module('@/lib/single-file-mode', () => ({ useSingleFileMode: () => singleFileValue }));

// Stub the heavy panel children so the test stays focused on tab visibility.
mock.module('@/components/OutlinePanel', () => ({
  OutlinePanel: () => <div data-testid="outline-panel" />,
}));
mock.module('@/components/LinksPanel', () => ({
  LinksPanel: () => <div data-testid="links-panel" />,
}));
mock.module('@/components/TimelinePanel', () => ({
  TimelineContent: () => <div data-testid="timeline-panel" />,
}));

const { DocPanel } = await import('./DocPanel');

function renderPanel(activeTab: 'outline' | 'links' | 'graph' | 'timeline') {
  return render(
    <TooltipProvider>
      <DocPanel
        docName="notes"
        isSourceMode={false}
        activeTab={activeTab}
        onActiveTabChange={() => {}}
        mode="doc"
      />
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  singleFileValue = false;
});

describe('DocPanel — single-file tab gating', () => {
  test('project mode renders the full tab strip (outline + links + graph + timeline)', () => {
    singleFileValue = false;
    renderPanel('outline');
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    expect(screen.getByTestId('outline-panel')).toBeTruthy();
  });

  test('single-file mode drops the tab strip and shows only the Outline', () => {
    singleFileValue = true;
    // Persisted selection is 'graph' — it must coerce back to Outline rather
    // than render a now-hidden panel.
    renderPanel('graph');
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.getByTestId('outline-panel')).toBeTruthy();
  });
});
