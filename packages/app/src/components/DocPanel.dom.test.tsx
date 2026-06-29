
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

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

let singleFileValue = false;
mock.module('@/lib/single-file-mode', () => ({ useSingleFileMode: () => singleFileValue }));

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
    renderPanel('graph');
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.getByTestId('outline-panel')).toBeTruthy();
  });
});
