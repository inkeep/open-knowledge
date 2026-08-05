/**
 * DOM tests for the Slidev action's cheap gate in the editor toolbar: it mounts
 * the lazy cluster only when the plugin is enabled AND the host exposes the
 * slides bridge AND a live provider + doc are present. The two remaining
 * conditions the cluster itself owns (the `slides: true` frontmatter flag and
 * the slidev-status probe) are covered in SlidesToolbarControls.dom.test.tsx.
 */

import type { HocuspocusProvider } from '@hocuspocus/provider';
import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

// Mutable so each test flips `slides.enabled`; the mock reads it per render.
let mockMergedConfig: { slides?: { enabled?: boolean } } | null = null;
// The toolbar reads config through the OPTIONAL accessor on purpose (it renders
// in provider-less mount orderings), so the mock has to stand in for that one —
// mocking the throwing `useConfigContext` here is what previously let a
// provider-less render regression pass unnoticed.
let mockConfigAbsent = false;
vi.doMock('@/lib/config-context', () => ({
  useConfigContextOptional: () =>
    mockConfigAbsent ? null : { merged: mockMergedConfig, projectLocalBinding: null },
}));

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

// The breadcrumb + not-in-sidebar chrome read config through their own hooks;
// stub them to isolate this file on the Slidev action.
vi.doMock('./EditorBreadcrumb', () => ({ EditorBreadcrumb: () => null }));
vi.doMock('./NotInSidebarIndicator', () => ({ NotInSidebarIndicator: () => null }));

interface FakeProvider {
  document: Y.Doc;
  on(event: 'synced', listener: () => void): void;
  off(event: 'synced', listener: () => void): void;
}

function makeDeckProvider(): FakeProvider {
  const document = new Y.Doc();
  document.getText('source').insert(0, '---\nslides: true\n---\nbody\n');
  const handlers = new Set<() => void>();
  return {
    document,
    on(event, listener) {
      if (event === 'synced') handlers.add(listener);
    },
    off(event, listener) {
      if (event === 'synced') handlers.delete(listener);
    },
  };
}

function installSlidesBridge() {
  (window as unknown as { okDesktop?: unknown }).okDesktop = {
    config: { projectPath: '/proj' },
    platform: 'darwin',
    slides: {
      status: () => Promise.resolve({ kind: 'status', available: true, source: 'global' }),
      open: () => Promise.resolve({ kind: 'open', ok: true }),
    },
  };
}

async function renderToolbar(provider: FakeProvider | null, docName: string | null = 'talks/Deck') {
  const { EditorToolbar } = await import('./EditorToolbar');
  return render(
    <TooltipProvider>
      <EditorToolbar
        activeDocName={docName}
        activeProvider={provider as unknown as HocuspocusProvider | null}
        isSourceMode={false}
        sourceDisabled={false}
        onModeChange={() => {}}
        showAddPropertyButton={false}
        onAddProperty={() => {}}
        isPanelCollapsed={false}
        onTogglePanel={() => {}}
      />
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  mockMergedConfig = null;
  (window as unknown as { okDesktop?: unknown }).okDesktop = undefined;
  vi.restoreAllMocks();
});

describe('EditorToolbar — Slidev action gate', () => {
  test('shows the action when the plugin is enabled on a deck with a resolvable slidev', async () => {
    mockMergedConfig = { slides: { enabled: true } };
    installSlidesBridge();
    await renderToolbar(makeDeckProvider());
    expect(await screen.findByTestId('slides-toolbar-action')).toBeTruthy();
  });

  test('hides the action when the plugin is disabled', async () => {
    mockMergedConfig = { slides: { enabled: false } };
    installSlidesBridge();
    await renderToolbar(makeDeckProvider());
    await Promise.resolve();
    expect(screen.queryByTestId('slides-toolbar-action')).toBeNull();
  });

  test('on a web host with no desktop bridge renders no action and logs no error', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockMergedConfig = { slides: { enabled: true } };
    // No okDesktop assigned → plain browser host.
    await renderToolbar(makeDeckProvider());
    await Promise.resolve();
    expect(screen.queryByTestId('slides-toolbar-action')).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe('EditorToolbar — renders without a config provider', () => {
  // The regression this pins: the slides gate first read config through the
  // THROWING `useConfigContext`. This toolbar renders for every document, and it
  // owns the frontmatter-problems badge — so in any mount ordering without a
  // `<ConfigProvider />` above it, the throw took the whole toolbar subtree down
  // and an unrelated badge silently resolved to zero elements. An off-by-default
  // plugin gate must not be able to unmount the toolbar.
  test('an absent config renders the toolbar and simply withholds the action', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockConfigAbsent = true;
    installSlidesBridge();

    await renderToolbar(makeDeckProvider());
    await Promise.resolve();

    // The toolbar itself is alive — the mode toggle is unconditional chrome.
    expect(screen.queryByTestId('slides-toolbar-action')).toBeNull();
    expect(document.body.textContent).not.toBe('');
    expect(consoleError).not.toHaveBeenCalled();
    mockConfigAbsent = false;
  });
});
