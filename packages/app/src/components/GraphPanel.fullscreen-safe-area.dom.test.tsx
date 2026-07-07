import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';
import {
  expectVisualClassTokens,
  expectVisualClassTokensAbsent,
} from '@/test-utils/visual-contract';

mock.module('@lingui/core/macro', () => ({
  t: renderLinguiTemplate,
}));

mock.module('@lingui/react/macro', () => ({
  Plural: ({ one }: { one: string }) => <>{one}</>,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

mock.module('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

mock.module('@/components/PageListContext', () => ({
  usePageList: () => ({
    assetPaths: new Set<string>(),
    error: null,
    folderPaths: new Set<string>(),
    loading: false,
    pages: new Set<string>(['docs/Active']),
    pagesBySlug: new Map<string, string>(),
    pageMeta: new Map(),
    pageTitles: new Map([['docs/Active', 'Active']]),
    refetch: () => {},
    addPage: () => {},
  }),
}));

mock.module('@/components/GraphView', () => ({
  GraphView: ({ isExpanded }: { isExpanded: boolean }) => (
    <div data-testid="graph-view" data-expanded={String(isExpanded)} />
  ),
}));

function setElectronHost(on: boolean) {
  const w = window as unknown as { okDesktop?: unknown };
  if (on) w.okDesktop = {};
  else delete w.okDesktop;
}

describe('GraphPanel fullscreen safe-area behavior', () => {
  afterEach(() => {
    cleanup();
    setElectronHost(false);
  });

  async function renderExpandedGraphPanel() {
    const { GraphPanel } = await import('./GraphPanel');
    render(
      <TooltipProvider>
        <GraphPanel activeDocName="docs/Active" />
      </TooltipProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Expand graph' }));
  }

  test('expanded overlay reserves the macOS traffic-light footprint at runtime', async () => {
    await renderExpandedGraphPanel();

    const graphView = screen.getByTestId('graph-view');
    const panel = graphView.closest('[data-slot="panel"]');
    expectVisualClassTokens(panel?.className, [
      'fixed',
      'inset-0',
      'z-50',
      'overflow-hidden',
      'bg-background',
    ]);
    // The overlay-wide no-drag was replaced by header-scoped drag (asserted
    // below) so the window stays draggable in graph mode — it must NOT come back.
    expectVisualClassTokensAbsent(panel?.className, ['[-webkit-app-region:no-drag]']);

    const header = panel?.querySelector('[data-slot="panel-header"]');
    // The fullscreen header lands on EditorHeader's content midline (y=32, where
    // the macOS traffic lights are tuned). The overlay is `fixed inset-0` so it
    // starts at y=0, 8px above EditorHeader's SidebarInset-`m-2` band — so it
    // needs `mt-2` (reproduce that 8px inset), `h-12` (the 48px band), and
    // `py-0` (drop PanelHeader's `py-3` so content centers in the full band).
    expectVisualClassTokens(header?.className, ['mt-2', 'h-12', 'py-0']);

    // The traffic-light footprint is reserved on the chrome row via the shared
    // token with its mandatory `,1rem` web fallback (precedent #49). The bare
    // no-fallback form collapses padding-left to 0 on web and must stay absent.
    expectVisualClassTokens(header?.className, ['pl-[var(--ok-titlebar-reserve-left,1rem)]']);
    expectVisualClassTokensAbsent(header?.className, ['pl-[var(--ok-titlebar-reserve-left)]']);

    // `pl-` replaces the base `px-4` (78px, not 16+78), which alone leaves the
    // title touching the buttons. The title cluster adds `ml-4` for the 16px of
    // clearance (94px total, measured) — without it the lights overlap "GRAPH".
    const titleCluster = header?.querySelector('[data-slot="graph-title-cluster"]');
    expectVisualClassTokens(titleCluster?.className, ['ml-4']);
  });

  test('fullscreen on Electron scopes window-drag to the header, controls opt out', async () => {
    setElectronHost(true);
    await renderExpandedGraphPanel();

    const panel = screen.getByTestId('graph-view').closest('[data-slot="panel"]');
    const header = panel?.querySelector('[data-slot="panel-header"]');
    // Header row IS the drag region (so the window stays draggable in graph
    // mode), tagged for the Popper-open neutralize rule.
    expectVisualClassTokens(header?.className, ['[-webkit-app-region:drag]']);
    expect(header?.getAttribute('data-electron-drag')).toBe('');

    // The controls cluster opts back out so the toggle / buttons are clickable
    // instead of starting a drag — same idiom as EditorHeader's right zone.
    const controls = header?.querySelector('[data-slot="graph-controls"]');
    expectVisualClassTokens(controls?.className, ['[&>*]:[-webkit-app-region:no-drag]']);
  });

  test('fullscreen off Electron declares no drag region', async () => {
    await renderExpandedGraphPanel();

    const header = screen
      .getByTestId('graph-view')
      .closest('[data-slot="panel"]')
      ?.querySelector('[data-slot="panel-header"]');
    // Web hosts have no OS titlebar; the drag affordance must not appear.
    expectVisualClassTokensAbsent(header?.className, ['[-webkit-app-region:drag]']);
    expect(header?.getAttribute('data-electron-drag')).toBeNull();
  });

  test('docked (non-expanded) graph does not reserve the traffic-light footprint', async () => {
    const { GraphPanel } = await import('./GraphPanel');
    render(
      <TooltipProvider>
        <GraphPanel activeDocName="docs/Active" />
      </TooltipProvider>,
    );

    const panel = screen.getByTestId('graph-view').closest('[data-slot="panel"]');
    const header = panel?.querySelector('[data-slot="panel-header"]');
    // The reserve + chrome-row sizing are fullscreen-only; the docked panel
    // sits inside the app shell, not at the window edge.
    expectVisualClassTokensAbsent(header?.className, [
      'pl-[var(--ok-titlebar-reserve-left,1rem)]',
      'mt-2',
      'h-12',
    ]);
    const titleCluster = header?.querySelector('[data-slot="graph-title-cluster"]');
    expectVisualClassTokensAbsent(titleCluster?.className, ['ml-4']);
  });
});
