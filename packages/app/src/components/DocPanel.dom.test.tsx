/**
 * Behavioral tests for DocPanel's tab strip: single-file gating + the Problems
 * tab badge.
 *
 * Single-file `ok <file>` keeps only the Outline + Problems tabs — Links/Graph
 * need a multi-doc knowledge base and Timeline is git history, all empty/inert
 * for a lone git-off file, but linting applies to any single file. Asserts the
 * rendered tab set (by `role="tab"` count, so the test doesn't depend on
 * localized label text), that a persisted now-hidden selection coerces back to
 * Outline, and that the Problems tab shows a count badge when there are
 * diagnostics.
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

import * as actualLinguiMacro from '@lingui/react/macro';

mock.module('@lingui/core/macro', () => ({ ...actualLinguiMacro, t: renderLinguiTemplate }));
mock.module('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

// Single-file signal — flipped per test.
let singleFileValue = false;
mock.module('@/lib/single-file-mode', () => ({ useSingleFileMode: () => singleFileValue }));

// Lint plumbing — DocPanel computes live diagnostics to drive the Problems
// badge. Stub the source so the test controls the count without a provider/fetch.
let diagnosticsValue: Array<{ severity: string }> = [];
mock.module('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ activeProvider: null, activeDocName: 'notes' }),
}));
mock.module('@/editor/lint-config-client', () => ({
  useDocLintConfig: () => ({ data: null }),
}));
mock.module('@/editor/useDocDiagnostics', () => ({
  useDocDiagnostics: () => diagnosticsValue,
}));

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
mock.module('@/components/ProblemsPanel', () => ({
  ProblemsPanel: () => <div data-testid="problems-panel" />,
}));

const { DocPanel } = await import('./DocPanel');

type Tab = 'outline' | 'links' | 'graph' | 'timeline' | 'problems';

function renderPanel(activeTab: Tab) {
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
  diagnosticsValue = [];
});

describe('DocPanel — tab gating', () => {
  test('project mode renders the full tab strip (outline + links + graph + timeline + problems)', () => {
    singleFileValue = false;
    renderPanel('outline');
    expect(screen.getAllByRole('tab')).toHaveLength(5);
    expect(screen.getByTestId('outline-panel')).toBeTruthy();
  });

  test('single-file mode keeps only Outline + Problems', () => {
    singleFileValue = true;
    // Persisted selection is 'graph' — it must coerce back to Outline rather
    // than render a now-hidden panel.
    renderPanel('graph');
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(screen.getByTestId('outline-panel')).toBeTruthy();
  });

  test('renders the Problems panel when its tab is active', () => {
    renderPanel('problems');
    expect(screen.getByTestId('problems-panel')).toBeTruthy();
  });
});

describe('DocPanel — Problems badge', () => {
  test('no badge when there are no diagnostics', () => {
    diagnosticsValue = [];
    renderPanel('outline');
    // The Problems tab is present but carries no count text.
    expect(screen.queryByText('3')).toBeNull();
  });

  test('shows the diagnostic count on the Problems tab', () => {
    diagnosticsValue = [{ severity: 'warning' }, { severity: 'error' }, { severity: 'warning' }];
    renderPanel('outline');
    expect(screen.getByText('3')).toBeTruthy();
  });

  test('caps the badge at 99+', () => {
    diagnosticsValue = Array.from({ length: 150 }, () => ({ severity: 'warning' }));
    renderPanel('outline');
    expect(screen.getByText('99+')).toBeTruthy();
  });
});
